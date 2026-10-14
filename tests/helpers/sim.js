'use strict';

// Deterministic test doubles: virtual clock, simulated CDN hosts behind a
// completion-callback HTTP client, and an in-memory persistent store.

const START = 1760400000000; // 2025-10-14T00:00:00Z

class FakeClock {
  constructor(start) {
    this.t = start || START;
    this.queue = [];
    this.seq = 0;
    this.now = () => this.t;
    this.setTimer = (fn, ms) => {
      this.queue.push({ at: this.t + Math.max(0, ms || 0), fn, seq: this.seq++ });
      return this.seq;
    };
  }

  advance(ms) {
    this.t += ms;
  }

  // Runs timers in virtual time until `promise` settles.
  async drive(promise, maxSteps) {
    let settled = false;
    let value;
    let error;
    promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; error = e; });
    for (let step = 0; step < (maxSteps || 200000); step++) {
      await flush();
      if (settled) break;
      if (!this.queue.length) throw new Error('deadlock: promise pending with no timers');
      this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.queue.shift();
      if (next.at > this.t) this.t = next.at;
      next.fn();
    }
    if (!settled) throw new Error('drive: step limit reached');
    if (error) throw error;
    return value;
  }
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// behaviors[host] = {latencyMs, mbps, kind, objectLength, status, retryAfter}
// kind: ok | timeout | status | full | html | short-body | wrong-range | redirect | hang | error
// failAbove: ranges larger than this many bytes time out (fast start, poor transfer)
// failFrom: ranges starting at or after this offset time out
function createCdn(clock, behaviors, defaults) {
  const calls = [];
  let inflight = 0;
  let peak = 0;
  const base = Object.assign({ latencyMs: 40, mbps: 50, kind: 'ok', objectLength: 50 * 1024 * 1024 }, defaults || {});

  function http(options) {
    const host = /^https:\/\/([^/]+)/.exec(options.url)[1];
    const b = Object.assign({}, base, behaviors[host] || {});
    const rm = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range || '');
    const start = rm ? Number(rm[1]) : 0;
    const end = rm ? Number(rm[2]) : b.objectLength - 1;
    const realEnd = Math.min(end, b.objectLength - 1);
    const bytes = realEnd - start + 1;
    const timeoutMs = Math.round(options.timeout * 1000);
    const call = { host, start, end, timeoutMs, at: clock.now(), headers: options.headers, options };
    calls.push(call);
    inflight++;
    if (inflight > peak) peak = inflight;
    return new Promise((resolve) => {
      function finish(delay, outcome) {
        clock.setTimer(() => {
          inflight--;
          call.doneAt = clock.now();
          resolve(outcome);
        }, delay);
      }
      if (b.kind === 'hang') return; // never calls back
      const transferMs = b.latencyMs + (bytes * 8) / (b.mbps * 1e6) * 1000;
      if (b.kind === 'timeout' || transferMs > timeoutMs || (b.failAbove && bytes > b.failAbove) || (b.failFrom !== undefined && start >= b.failFrom)) {
        finish(timeoutMs, { error: 'The request timed out.' });
        return;
      }
      if (b.kind === 'error') {
        finish(b.latencyMs, { error: 'A server with the specified hostname could not be found.' });
        return;
      }
      const headers = { 'Content-Type': 'video/mp4' };
      let status = 206;
      let length = bytes;
      if (b.kind === 'status') {
        status = b.status;
        length = 0;
        if (b.retryAfter) headers['Retry-After'] = String(b.retryAfter);
      } else if (b.kind === 'full') {
        status = 200;
        length = b.objectLength;
      } else if (b.kind === 'redirect') {
        status = 302;
        length = 0;
        headers.Location = 'https://elsewhere.bilivideo.com/x';
      } else {
        headers['Content-Range'] = 'bytes ' + start + '-' + (b.kind === 'wrong-range' ? realEnd - 1 : realEnd) + '/' + b.objectLength;
        if (b.kind === 'html') headers['Content-Type'] = 'text/html';
        if (b.kind === 'short-body') length = bytes - 100;
        if (b.kind === 'wrong-range') length = bytes - 1;
      }
      if (start >= b.objectLength && b.kind === 'ok') {
        status = 416;
        length = 0;
        headers['Content-Range'] = 'bytes */' + b.objectLength;
      }
      finish(transferMs, { error: null, response: { status, headers }, data: { byteLength: length } });
    });
  }

  return { http, calls, peak: () => peak, inflight: () => inflight };
}

function memoryBackend(initial) {
  const data = Object.assign({}, initial || {});
  return {
    data,
    read: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    write: (value, key) => {
      if (value === null) delete data[key];
      else data[key] = value;
      return true;
    },
  };
}

const NATIVE = 'upos-sz-mirroraliov.bilivideo.com';

function mediaUrl(opts) {
  const o = Object.assign({ host: NATIVE, cid: '1234567890', rep: 30080, deadlineSec: Math.floor(START / 1000) + 7200 }, opts || {});
  return 'https://' + o.host + '/upgcxcode/90/78/' + o.cid + '/' + o.cid + '-1-' + o.rep + '.m4s' +
    '?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M=' +
    '&uipk=5&nbs=1&deadline=' + o.deadlineSec + '&gen=playurlv2&os=aliov&oi=0&trid=abc%2Bdef&mid=0&platform=iphone&upsig=0123456789abcdef0123456789abcdef&uparams=e,uipk,nbs,deadline,gen,os,oi,trid,mid,platform&bvc=vod&nettype=0&orderid=0,3&buvid=&build=80000100&f=u_0_0&agrr=1&bw=253117&logo=80000000';
}

module.exports = { FakeClock, createCdn, memoryBackend, mediaUrl, flush, START, NATIVE };
