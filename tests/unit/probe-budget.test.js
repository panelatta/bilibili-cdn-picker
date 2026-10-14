'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateProbe, buildProbeRequest, parseContentRange, classifyError, rangeHeader } = require('../../src/core/probe');
const { Budget } = require('../../src/core/budget');
const { CutoffTracker } = require('../../src/core/cutoff');
const { effectiveMbps } = require('../../src/core/format');
const { resolveConfig } = require('../../src/core/config');
const { mediaUrl } = require('../helpers/sim');

const KiB = 1024;
const spec = { host: 'cn-a.bilivideo.com', stage: 'coarse', rangeStart: 0, rangeBytes: 128 * KiB, timeoutMs: 800, startedAt: 1000, order: 0 };

function outcome(status, headers, bytes, completedAt) {
  return { response: { status, headers }, data: bytes === null ? null : { byteLength: bytes }, completedAt: completedAt || 1045 };
}

test('range header uses inclusive end offsets', () => {
  assert.equal(rangeHeader(0, 131072), 'bytes=0-131071');
  assert.equal(rangeHeader(0, 262144), 'bytes=0-262143');
  assert.equal(rangeHeader(0, 1048576), 'bytes=0-1048575');
});

test('effective rate examples from the design', () => {
  assert.equal(Math.round(effectiveMbps(256 * KiB, 80) * 100) / 100, 26.21);
  assert.equal(Math.round(effectiveMbps(128 * KiB, 45) * 100) / 100, 23.3);
});

test('a matching 206 is the only valid sample', () => {
  const ok = evaluateProbe(spec, outcome(206, { 'content-range': 'bytes 0-131071/9000000', 'Content-Type': 'video/mp4' }, 131072));
  assert.equal(ok.ok, true);
  assert.equal(ok.objectLength, 9000000);
  assert.equal(ok.elapsedMs, 45);
  const reject = (status, headers, bytes) => evaluateProbe(spec, outcome(status, headers, bytes)).kind;
  assert.equal(reject(206, { 'Content-Range': 'bytes 1-131072/9000000' }, 131072), 'range-mismatch');
  assert.equal(reject(206, { 'Content-Range': 'bytes 0-65535/9000000' }, 65536), 'range-mismatch');
  assert.equal(reject(206, { 'Content-Range': 'bytes 0-131071/9000000' }, 1000), 'length-mismatch');
  assert.equal(reject(206, {}, 131072), 'bad-content-range');
  assert.equal(reject(206, { 'Content-Range': 'bytes 0-131071/9000000', 'Content-Type': 'text/html; charset=utf-8' }, 131072), 'error-body');
  assert.equal(reject(206, { 'Content-Range': 'bytes 0-131071/9000000', 'Content-Type': 'application/json' }, 131072), 'error-body');
  assert.equal(reject(200, {}, 9000000), 'range-ignored');
  assert.equal(reject(302, { Location: 'https://other/' }, 0), 'redirect');
  assert.equal(reject(403, {}, 0), 'forbidden');
  assert.equal(reject(404, {}, 0), 'not-found');
  assert.equal(reject(503, {}, 0), 'server-error');
  assert.equal(reject(418, {}, 0), 'http-error');
  const short = evaluateProbe(spec, outcome(206, { 'Content-Range': 'bytes 0-99999/100000' }, 100000));
  assert.equal(short.kind, 'short-object');
  assert.equal(short.objectLength, 100000);
  const r416 = evaluateProbe(spec, outcome(416, { 'Content-Range': 'bytes */5000' }, 0));
  assert.equal(r416.kind, 'range-unsatisfiable');
  assert.equal(r416.objectLength, 5000);
  const r429 = evaluateProbe(spec, outcome(429, { 'Retry-After': '120' }, 0));
  assert.equal(r429.retryAfterSec, 120);
  const text = evaluateProbe(spec, { response: { status: 206, headers: { 'Content-Range': 'bytes 0-131071/9000000' } }, data: 'x'.repeat(131072), completedAt: 1045 });
  assert.equal(text.kind, 'error-body');
});

test('errors never report a byte count', () => {
  const r = evaluateProbe(spec, { error: 'The request timed out.', completedAt: 1800 });
  assert.equal(r.kind, 'timeout');
  assert.equal(r.bytes, null);
  assert.equal(r.status, null);
  assert.equal(classifyError('A server with the specified hostname could not be found.'), 'dns');
  assert.equal(classifyError('An SSL error has occurred'), 'tls');
  assert.equal(classifyError('Could not connect to the server.'), 'connect');
  assert.equal(parseContentRange('bytes 5-4/10'), null);
  assert.equal(parseContentRange('bytes 0-10/10'), null);
  assert.deepEqual(parseContentRange('bytes 0-9/*'), { start: 0, end: 9, total: null });
});

test('probe request: same path and query, filtered headers, no redirects', () => {
  const { config } = resolveConfig('probePolicy=Proxy', null);
  const url = mediaUrl();
  const req = buildProbeRequest({
    sampleUrl: url,
    sampleHeaders: { 'User-Agent': 'bili', Cookie: 'SESSDATA=secret', Range: 'bytes=500-999' },
    host: 'cn-hk-eq-01-14.bilivideo.com',
    rangeStart: 0,
    rangeBytes: 128 * KiB,
    timeoutMs: 800,
    config,
    runId: 'run1',
  });
  assert.equal(req.url, url.replace('upos-sz-mirroraliov.bilivideo.com', 'cn-hk-eq-01-14.bilivideo.com'));
  assert.equal(req.headers.Range, 'bytes=0-131071');
  assert.equal(req.headers['Accept-Encoding'], 'identity');
  assert.equal(req.headers.Cookie, undefined);
  assert.equal(req.headers['X-BCP-Probe'], 'run1');
  assert.equal(req.timeout, 0.8);
  assert.equal(req['binary-mode'], true);
  assert.equal(req['auto-redirect'], false);
  assert.equal(req['auto-cookie'], false);
  assert.equal(req.policy, 'Proxy');
});

test('budget reserves before dispatch and keeps unobservable bytes conservative', () => {
  const b = new Budget(1000);
  const t1 = b.reserve(400);
  const t2 = b.reserve(400);
  assert.ok(t1 && t2);
  assert.equal(b.reserve(400), null, 'parallel workers cannot over-reserve');
  assert.equal(b.canReserve(100, 150), false, 'keep-back is honoured');
  b.settle(t1, 300);
  b.settle(t2, null);
  b.settle(t2, 0); // double settle ignored
  const r = b.report();
  assert.equal(r.observedBytes, 300);
  assert.equal(r.unobservableBytes, 400);
  assert.equal(r.unobservableCount, 1);
  assert.equal(r.outstandingBytes, 0);
  assert.equal(b.remaining(), 300);
  const t3 = b.reserve(300);
  b.settle(t3, 5000);
  assert.equal(b.report().overrunCount, 1);
  assert.equal(b.report().exhausted, true);
});

test('dynamic cutoff: clamp(2.5 × kth best) with loose probes', () => {
  const c = new CutoffTracker({ initialMs: 800, minMs: 300, maxMs: 800, alpha: 2.5, k: 3, looseEvery: 10 });
  assert.equal(c.timeoutFor(0), 800);
  c.record(100);
  c.record(40);
  assert.equal(c.timeoutFor(1), 800, 'not enough results yet');
  c.record(120);
  assert.equal(c.timeoutFor(2), 300);
  c.record(10);
  assert.equal(c.timeoutFor(3), 300, 'never below the minimum');
  assert.equal(c.timeoutFor(9), 800, 'every 10th dispatch stays loose');
  const wide = new CutoffTracker({ initialMs: 800, minMs: 300, maxMs: 800, alpha: 2.5, k: 1 });
  wide.record(500);
  assert.equal(wide.timeoutFor(0), 800, 'never above the maximum');
});
