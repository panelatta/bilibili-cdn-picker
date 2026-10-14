'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleRequest } = require('../../src/app/router');
const { handleResponse } = require('../../src/app/observer');
const { handleNetworkChange } = require('../../src/app/network-event');
const { matchMediaRequest } = require('../../src/media/adapters');
const S = require('../../src/core/state');
const { memoryBackend, mediaUrl, NATIVE, START } = require('../helpers/sim');
const { ensureMeta, currentNetwork, loadConfig } = require('../../src/app/context');

const WIFI = { wifi: { ssid: 'Home' }, v4: { primaryInterface: 'en0' } };
const HEADERS = { Host: NATIVE, 'User-Agent': 'bili-ios', Range: 'bytes=1000-1999', Cookie: 'SESSDATA=secret' };

function env(argument, initial) {
  const backend = memoryBackend(initial);
  const store = S.createStore(backend);
  let now = START;
  let network = WIFI;
  let seq = 0;
  const api = [];
  const context = () => ({ argument: argument || '', network, store: S.createStore(backend), now: () => now });
  return {
    backend, store, api,
    tick: (ms) => { now += ms; },
    now: () => now,
    setNetwork(n) { network = n; handleNetworkChange({ store, now: () => now }); },
    networkKey() { return currentNetwork(network, ensureMeta(store, now), loadConfig(store, argument || '').config).key; },
    failures() { return S.loadFailures(store, this.networkKey()); },
    request(url, extra) {
      return handleRequest(Object.assign(context(), {
        request: { id: 'req-' + ++seq, url: url || mediaUrl(), method: 'GET', headers: Object.assign({}, HEADERS) },
        httpApi: (m, p, b) => api.push([m, p, b]),
      }, extra || {}));
    },
    dispatch(url, headers) {
      const original = { id: 'req-' + ++seq, url: url || mediaUrl(), method: 'GET', headers: Object.assign({}, HEADERS, headers || {}) };
      const out = handleRequest(Object.assign(context(), { request: original }));
      return { original, actual: Object.assign({}, original, out) };
    },
    response(request, status) {
      return handleResponse(Object.assign(context(), { request, response: { status, headers: {} } }));
    },
    decide(winner, backups, over) {
      const key = matchMediaRequest(mediaUrl(), 'GET').info.resourceKey;
      const decisions = S.loadDecisions(store);
      decisions.items[key] = Object.assign({
        key, winner, backupVersion: 1, backups: backups || [], networkKey: this.networkKey(), nativeHost: NATIVE,
        expiresAt: now + 600000, decidedAt: now, score: 100, runId: 'decision-' + ++seq,
      }, over || {});
      store.writeJson(S.KEYS.decisions, decisions);
      return key;
    },
  };
}

test('non-media requests pass through without touching the store', () => {
  let reads = 0;
  const out = handleRequest({
    request: { url: 'https://api.bilibili.com/x/player/playurl?x=1', method: 'GET', headers: {} },
    store: S.createStore({ read: () => { reads++; return null; }, write: () => true }),
    now: () => START,
    network: WIFI,
  });
  assert.deepEqual(out, {});
  assert.equal(reads, 0);
});

test('no decision: request passes through and a filtered sample is captured once', () => {
  const e = env();
  assert.deepEqual(e.request(), {});
  const samples = S.loadSamples(e.store);
  const items = Object.values(samples.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, mediaUrl());
  assert.equal(items[0].nativeHost, NATIVE);
  assert.deepEqual(items[0].headers, { 'User-Agent': 'bili-ios' });
  assert.ok(items[0].expiresAt <= START + 120000);
  const raw = e.backend.data[S.KEYS.samples];
  e.tick(5000);
  e.request();
  assert.equal(e.backend.data[S.KEYS.samples], raw, 'throttled: no write within the refresh window');
  e.tick(20000);
  e.request();
  assert.notEqual(e.backend.data[S.KEYS.samples], raw);
});

test('sample lifetime never exceeds the signature deadline', () => {
  const e = env();
  const url = mediaUrl({ deadlineSec: Math.floor(START / 1000) + 60 });
  e.request(url);
  const s = Object.values(S.loadSamples(e.store).items)[0];
  assert.equal(s.expiresAt, START + 30000);
  const e2 = env();
  e2.request(mediaUrl({ deadlineSec: Math.floor(START / 1000) + 10 }));
  assert.deepEqual(S.loadSamples(e2.store).items, {});
});

test('a valid decision rewrites only the host and Host header', () => {
  const e = env();
  e.decide('cn-hk-eq-01-14.bilivideo.com');
  const out = e.request();
  assert.equal(out.url, mediaUrl().replace(NATIVE, 'cn-hk-eq-01-14.bilivideo.com'));
  assert.equal(out.headers.Host, 'cn-hk-eq-01-14.bilivideo.com');
  assert.equal(out.headers.Range, 'bytes=1000-1999');
  assert.equal(out.headers.Cookie, 'SESSDATA=secret', 'the App request keeps its own headers');
  e.tick(600001);
  assert.deepEqual(e.request(), {}, 'expired decision falls back to the original request');
});

test('disabled, paused or corrupt state always passes through', () => {
  const off = env('enabled=false');
  off.decide('cn-hk-eq-01-14.bilivideo.com');
  assert.deepEqual(off.request(), {});
  const paused = env('', { [S.KEYS.control]: JSON.stringify({ paused: true }) });
  paused.decide('cn-hk-eq-01-14.bilivideo.com');
  assert.deepEqual(paused.request(), {});
  const corrupt = env('', { [S.KEYS.decisions]: '{{{', [S.KEYS.failures]: 'null', [S.KEYS.meta]: '[]' });
  assert.deepEqual(corrupt.request(), {});
});

test('runner probes are stripped of the marker and never rewritten or sampled', () => {
  const e = env();
  e.decide('cn-hk-eq-01-14.bilivideo.com');
  const out = e.request(mediaUrl({ host: 'cn-jxnc-cm-01-04.bilivideo.com' }), {
    request: { url: mediaUrl({ host: 'cn-jxnc-cm-01-04.bilivideo.com' }), method: 'GET', headers: { 'X-BCP-Probe': 'run', Range: 'bytes=0-131071' } },
  });
  assert.deepEqual(out, { headers: { Range: 'bytes=0-131071' } });
  assert.deepEqual(S.loadSamples(e.store).items, {});
});

test('adaptive mode triggers the runner through the HTTP API, throttled', () => {
  const e = env('mode=adaptive');
  e.request();
  assert.deepEqual(e.api, [['POST', '/v1/scripting/cron/evaluate', { script_name: 'BiliCDN-Runner' }]]);
  e.tick(21000);
  e.request();
  assert.equal(e.api.length, 1, 'trigger interval not reached');
  e.tick(10000);
  e.request(mediaUrl({ rep: 30280 }));
  assert.equal(e.api.length, 2);
  const manual = env();
  manual.request();
  assert.equal(manual.api.length, 0);
});

test('observer: 403 on the rewritten host falls back to a confirmed backup, then native', () => {
  const e = env();
  const winner = 'cn-hk-eq-01-14.bilivideo.com';
  const backup = 'cn-bj-se-01-05.bilivideo.com';
  e.decide(winner, [backup]);
  assert.equal(e.response(e.dispatch().actual, 206), null);
  const r = e.response(e.dispatch().actual, 403);
  assert.equal(r.host, winner);
  assert.equal(r.inferred, false);
  assert.equal(e.request().headers.Host, backup);
  e.response(e.dispatch().actual, 404);
  assert.deepEqual(e.request(), {});
});

test('delayed native failure is never attributed to a winner selected after dispatch', () => {
  const e = env();
  const pending = e.dispatch();
  const winner = 'cn-hk-eq-01-14.bilivideo.com';
  e.decide(winner);
  const r = e.response(pending.actual, 403);
  assert.equal(r.host, NATIVE);
  assert.equal(r.inferred, false);
  assert.equal(e.failures().hosts[winner], undefined);
  assert.equal(e.request().headers.Host, winner);
});

test('response uses the captured target even if Surge exposes the original URL or decision changes', () => {
  const e = env();
  const a = 'cn-hk-eq-01-14.bilivideo.com', b = 'cn-bj-se-01-05.bilivideo.com';
  e.decide(a);
  const pending = e.dispatch();
  e.decide(b);
  assert.equal(e.response(pending.original, 403).host, a);
  assert.equal(e.failures().hosts[b], undefined);
  assert.equal(e.request().headers.Host, b);
});

test('missing, expired or mismatched request IDs cannot create failure attribution', () => {
  const e = env();
  e.decide('cn-hk-eq-01-14.bilivideo.com');
  const pending = e.dispatch().actual;
  assert.equal(e.response({ ...pending, id: undefined }, 403), null);
  assert.equal(e.response({ ...pending, id: 'unobserved' }, 403), null);
  assert.equal(e.response({ ...pending, url: mediaUrl({ rep: 30064 }) }, 403), null);
  e.tick(300001);
  assert.equal(e.response(pending, 403), null);
  assert.deepEqual(e.failures().resources, {});
});

test('observer: native 403 invalidates only that sample; expired signatures are ignored', () => {
  const e = env();
  const r = e.response(e.dispatch().actual, 403);
  assert.equal(r.kind, 'forbidden');
  assert.ok(Object.values(e.failures().resources)[0].nativeFailedAt);
  assert.deepEqual(e.failures().hosts, {});
  const expired = e.dispatch(mediaUrl({ deadlineSec: Math.floor(START / 1000) - 5 }));
  assert.equal(e.response(expired.actual, 403), null);
});

test('observer: repeated 403s on distinct resources cool the host down', () => {
  const e = env();
  const host = 'cn-hk-eq-01-14.bilivideo.com';
  [30080, 30064, 30032].forEach((rep) => {
    const key = matchMediaRequest(mediaUrl({ rep }), 'GET').info.resourceKey;
    const d = S.loadDecisions(e.store);
    d.items[key] = { key, winner: host, backupVersion: 1, backups: [], networkKey: e.networkKey(), nativeHost: NATIVE,
      expiresAt: e.now() + 600000, decidedAt: e.now(), score: 90, runId: 'test-' + rep };
    e.store.writeJson(S.KEYS.decisions, d);
    e.response(e.dispatch(mediaUrl({ rep })).actual, 403);
  });
  assert.ok(e.failures().hosts[host].until > e.now());
  const other = 'cn-bj-se-01-05.bilivideo.com';
  e.decide(other);
  e.response(e.dispatch().actual, 503);
  assert.equal(e.failures().hosts[other].reason, 'server-error');
});

test('network change bumps the generation', () => {
  const store = S.createStore(memoryBackend());
  assert.equal(handleNetworkChange({ store, now: () => START }), 1);
  assert.equal(handleNetworkChange({ store, now: () => START }), 2);
});

test('stripped probes cannot poison native, winner or backup failures', () => {
  const e = env();
  const a = 'cn-hk-eq-01-14.bilivideo.com', b = 'cn-bj-se-01-05.bilivideo.com';
  e.decide(a, [b]);
  for (const host of [NATIVE, a, b, 'cn-jxnc-cm-01-04.bilivideo.com']) {
    const probe = e.dispatch(mediaUrl({ host }), { Host: host, 'X-BCP-Probe': 'run' });
    assert.equal(probe.actual.headers['X-BCP-Probe'], undefined);
    assert.equal(e.response(probe.actual, 403), null);
  }
  assert.deepEqual(e.failures().resources, {});
  assert.equal(e.request().headers.Host, a);
});

test('parallel failures of one host count as one switch; transient errors expire', () => {
  for (const status of [403, 503]) {
    const e = env();
    const host = 'cn-hk-eq-01-14.bilivideo.com', backup = 'cn-bj-se-01-05.bilivideo.com';
    e.decide(host, [backup]);
    const pending = Array.from({ length: 3 }, () => e.dispatch().actual);
    pending.forEach((req) => e.response(req, status));
    assert.equal(Object.values(e.failures().resources)[0].count, 1);
    assert.equal(e.request().headers.Host, backup);
    if (status === 503) {
      e.tick(301000);
      assert.equal(e.request().headers.Host, host);
    }
  }
});

test('failures and late responses stay on the dispatch network and exit revision', () => {
  const e = env();
  const host = 'cn-hk-eq-01-14.bilivideo.com';
  e.decide(host);
  const oldKey = e.networkKey(), pending = e.dispatch().actual;
  const cell = { v4: { primaryInterface: 'pdp_ip0' }, 'cellular-data': { carrier: 'Singtel', radio: 'NR' } };
  e.setNetwork(cell);
  e.decide(host);
  e.response(pending, 503);
  assert.ok(S.loadFailures(e.store, oldKey).hosts[host].until > e.now());
  assert.deepEqual(e.failures(), { resources: {}, hosts: {} });
  assert.equal(e.request().headers.Host, host);
  const cellPending = e.dispatch().actual, cellKey = e.networkKey();
  e.store.writeJson(S.KEYS.config, { routeRevision: 'another-exit' });
  e.decide(host);
  e.response(cellPending, 403);
  assert.ok(Object.keys(S.loadFailures(e.store, cellKey).resources).length);
  assert.deepEqual(e.failures().resources, {});
  assert.equal(e.request().headers.Host, host);
});

test('debug mode emits a matched-request marker without exposing the signed query', () => {
  const e = env('debug=true'), lines = [];
  e.request(mediaUrl({ host: 'upos-hz-mirrorakam.akamaized.net', rep: 30232 }), { log: (line) => lines.push(line) });
  assert.ok(lines.some((line) => line.includes('router_matched audio host=upos-hz-mirrorakam.akamaized.net')));
  assert.ok(lines.every((line) => !line.includes('upsig') && !line.includes('deadline=')));
});
