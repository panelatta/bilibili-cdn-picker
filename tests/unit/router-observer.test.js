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
  const api = [];
  return {
    backend,
    store,
    api,
    tick: (ms) => { now += ms; },
    now: () => now,
    request(url, extra) {
      return handleRequest(Object.assign({
        request: { url: url || mediaUrl(), method: 'GET', headers: Object.assign({}, HEADERS) },
        argument: argument || '',
        network: WIFI,
        store: S.createStore(backend),
        now: () => now,
        httpApi: (m, p, b) => api.push([m, p, b]),
      }, extra || {}));
    },
    response(url, status, headers, extra) {
      return handleResponse(Object.assign({
        request: { url, method: 'GET', headers: Object.assign({}, HEADERS, headers || {}) },
        response: { status, headers: {} },
        argument: argument || '',
        network: WIFI,
        store: S.createStore(backend),
        now: () => now,
      }, extra || {}));
    },
    decide(winner, backups, over) {
      const meta = ensureMeta(store, now);
      const config = loadConfig(store, argument || '').config;
      const net = currentNetwork(WIFI, meta, config);
      const key = matchMediaRequest(mediaUrl(), 'GET').info.resourceKey;
      const decisions = S.loadDecisions(store);
      decisions.items[key] = Object.assign({
        key, winner, backups: backups || [], networkKey: net.key, nativeHost: NATIVE, expiresAt: now + 600000, decidedAt: now, score: 100,
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

test('observer: 403 on the rewritten host falls back to the backup, then native', () => {
  const e = env();
  e.decide('cn-hk-eq-01-14.bilivideo.com', ['cn-bj-se-01-05.bilivideo.com']);
  assert.equal(e.response(mediaUrl({ host: 'cn-hk-eq-01-14.bilivideo.com' }), 206), null, '206 is the fast path');
  const r = e.response(mediaUrl({ host: 'cn-hk-eq-01-14.bilivideo.com' }), 403);
  assert.equal(r.host, 'cn-hk-eq-01-14.bilivideo.com');
  assert.equal(r.inferred, false);
  assert.equal(e.request().headers.Host, 'cn-bj-se-01-05.bilivideo.com');
  e.response(mediaUrl({ host: 'cn-bj-se-01-05.bilivideo.com' }), 404);
  assert.deepEqual(e.request(), {});
});

test('observer attributes a failure seen on the native URL to the active route', () => {
  const e = env();
  e.decide('cn-hk-eq-01-14.bilivideo.com');
  const r = e.response(mediaUrl(), 403, { Host: NATIVE });
  assert.equal(r.host, 'cn-hk-eq-01-14.bilivideo.com');
  assert.equal(r.inferred, true);
  assert.deepEqual(e.request(), {});
});

test('observer: native 403 invalidates the sample; expired signatures are ignored', () => {
  const e = env();
  e.request();
  const r = e.response(mediaUrl(), 403);
  assert.equal(r.kind, 'forbidden');
  const failures = S.loadFailures(e.store);
  const rf = Object.values(failures.resources)[0];
  assert.ok(rf.nativeFailedAt);
  assert.deepEqual(failures.hosts, {});
  const expired = env();
  assert.equal(expired.response(mediaUrl({ deadlineSec: Math.floor(START / 1000) - 5 }), 403), null);
  assert.equal(e.response(mediaUrl(), 403, { 'X-BCP-Probe': 'r' }), null, 'own probes are ignored');
});

test('observer: repeated 403s on distinct resources cool the host down', () => {
  const e = env();
  const host = 'cn-hk-eq-01-14.bilivideo.com';
  [30080, 30064, 30032].forEach((rep) => {
    const meta = ensureMeta(e.store, e.now());
    const net = currentNetwork(WIFI, meta, loadConfig(e.store, '').config);
    const key = matchMediaRequest(mediaUrl({ rep }), 'GET').info.resourceKey;
    const d = S.loadDecisions(e.store);
    d.items[key] = { key, winner: host, backups: [], networkKey: net.key, nativeHost: NATIVE, expiresAt: e.now() + 600000, decidedAt: e.now(), score: 90 };
    e.store.writeJson(S.KEYS.decisions, d);
    e.response(mediaUrl({ rep, host }), 403);
  });
  const hf = S.loadFailures(e.store).hosts[host];
  assert.ok(hf.until > e.now());
  const other = 'cn-bj-se-01-05.bilivideo.com';
  e.decide(other);
  e.response(mediaUrl({ host: other }), 503);
  assert.equal(S.loadFailures(e.store).hosts[other].reason, 'server-error');
});

test('network change bumps the generation', () => {
  const backend = memoryBackend();
  const store = S.createStore(backend);
  assert.equal(handleNetworkChange({ store, now: () => START }), 1);
  assert.equal(handleNetworkChange({ store, now: () => START }), 2);
  assert.equal(S.loadMeta(store).generation, 2);
});

test('observer ignores failures on hosts outside the resource route (stripped probes)', () => {
  const e = env();
  e.decide('cn-hk-eq-01-14.bilivideo.com', ['cn-bj-se-01-05.bilivideo.com']);
  for (let i = 0; i < 4; i++) {
    assert.equal(e.response(mediaUrl({ host: 'cn-jxnc-cm-01-04.bilivideo.com' }), 403, { Host: 'cn-jxnc-cm-01-04.bilivideo.com' }), null);
  }
  assert.equal(e.response(mediaUrl({ host: 'cn-jxnc-cm-01-04.bilivideo.com' }), 200), null);
  assert.deepEqual(S.loadFailures(e.store).resources, {});
  assert.equal(e.request().headers.Host, 'cn-hk-eq-01-14.bilivideo.com');
});

test('parallel failures of one host count as one switch; transient errors expire', () => {
  const e = env();
  const host = 'cn-hk-eq-01-14.bilivideo.com';
  e.decide(host, ['cn-bj-se-01-05.bilivideo.com']);
  for (let i = 0; i < 3; i++) e.response(mediaUrl({ host }), 403, { Host: host });
  assert.equal(Object.values(S.loadFailures(e.store).resources)[0].count, 1);
  assert.equal(e.request().headers.Host, 'cn-bj-se-01-05.bilivideo.com', 'backup first, not native');

  const t = env();
  t.decide(host, []);
  for (let i = 0; i < 3; i++) t.response(mediaUrl({ host }), 503, { Host: host });
  assert.equal(Object.values(S.loadFailures(t.store).resources)[0].count, 1);
  assert.deepEqual(t.request(), {}, 'cooling down: native');
  t.tick(301000);
  t.decide(host, []);
  assert.equal(t.request().headers.Host, host, 'retried after the short cooldown');
});
