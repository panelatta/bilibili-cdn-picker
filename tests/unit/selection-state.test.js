'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideReplacement, chooseRoute, targetMbps } = require('../../src/core/selection');
const { applyFailure, coolingReason, pruneCooldowns } = require('../../src/core/cooldown');
const S = require('../../src/core/state');
const { resolveConfig } = require('../../src/core/config');
const { createLogger } = require('../../src/core/log');
const { memoryBackend } = require('../helpers/sim');

const config = resolveConfig('', null).config;
const NOW = 1760400000000;

test('target: 4 × known bitrate, otherwise the configured value', () => {
  assert.equal(targetMbps(config, 10), 40);
  assert.equal(targetMbps(config, null), 80);
  assert.equal(targetMbps(config, 0), 80);
});

test('hysteresis: dwell time and 1.25× improvement, failures bypass both', () => {
  const current = { winner: 'a', score: 100, decidedAt: NOW - 30000, expiresAt: NOW + 60000 };
  assert.equal(decideReplacement(current, { host: 'b', score: 500 }, NOW, config).reason, 'dwell');
  const old = Object.assign({}, current, { decidedAt: NOW - 120000 });
  assert.equal(decideReplacement(old, { host: 'b', score: 120 }, NOW, config).replace, false);
  assert.equal(decideReplacement(old, { host: 'b', score: 125 }, NOW, config).replace, true);
  assert.equal(decideReplacement(Object.assign({}, current, { failed: true }), { host: 'b', score: 1 }, NOW, config).reason, 'current-failed');
  assert.equal(decideReplacement(current, { host: 'a', score: 1 }, NOW, config).reason, 'refresh');
  assert.equal(decideReplacement(null, { host: 'a', score: 1 }, NOW, config).reason, 'new');
});

function route(over) {
  return chooseRoute(Object.assign({
    now: NOW,
    nativeHost: 'native.bilivideo.com',
    resourceKey: 'v-1',
    networkKey: 'net',
    decision: { winner: 'cn-a.bilivideo.com', backups: ['cn-b.bilivideo.com'], networkKey: 'net', expiresAt: NOW + 1000 },
    networkBest: null,
    failures: { resources: {}, hosts: {} },
    config,
    isValidHost: (h) => /\.bilivideo\.com$/.test(h),
  }, over));
}

test('routing: decision, fallback chain, switch limit and network isolation', () => {
  assert.deepEqual(route({}), { host: 'cn-a.bilivideo.com', reason: 'decision' });
  const failedA = { resources: { 'v-1': { hosts: { 'cn-a.bilivideo.com': { status: 403 } }, count: 1 } }, hosts: {} };
  assert.deepEqual(route({ failures: failedA }), { host: 'cn-b.bilivideo.com', reason: 'decision-fallback' });
  const failedBoth = { resources: { 'v-1': { hosts: { 'cn-a.bilivideo.com': {}, 'cn-b.bilivideo.com': {} }, count: 2 } }, hosts: {} };
  assert.equal(route({ failures: failedBoth }).host, 'native.bilivideo.com');
  const limit = { resources: { 'v-1': { hosts: {}, count: 3 } }, hosts: {} };
  assert.equal(route({ failures: limit }).reason, 'switch-limit');
  const hostCooling = { resources: {}, hosts: { 'cn-a.bilivideo.com': { until: NOW + 1 } } };
  assert.equal(route({ failures: hostCooling }).host, 'cn-b.bilivideo.com');
  assert.equal(route({ networkKey: 'other' }).reason, 'no-decision');
  assert.equal(route({ decision: { winner: 'cn-a.bilivideo.com', backups: [], networkKey: 'net', expiresAt: NOW } }).reason, 'no-decision');
  assert.equal(route({ decision: { winner: 'evil.example', backups: [], networkKey: 'net', expiresAt: NOW + 5 } }).reason, 'fallback-native');
  assert.equal(route({ decision: { winner: 'native.bilivideo.com', backups: [], networkKey: 'net', expiresAt: NOW + 5 } }).reason, 'decision-native');
});

test('history winners are only used with the optimistic policy', () => {
  const best = { hosts: ['cn-h.bilivideo.com'], expiresAt: NOW + 1000 };
  assert.equal(route({ decision: null, networkBest: best }).reason, 'no-decision');
  const optimistic = resolveConfig('historyPolicy=optimistic', null).config;
  assert.deepEqual(route({ decision: null, networkBest: best, config: optimistic }), { host: 'cn-h.bilivideo.com', reason: 'history' });
});

test('a single resource 403 does not poison the host; repeated ones do', () => {
  const cooldowns = {};
  const strikes = {};
  const ctx = (key, now) => ({ now, resourceKey: key, resourceTtlMs: 600000 });
  applyFailure(cooldowns, strikes, { host: 'h', kind: 'forbidden' }, ctx('r1', NOW));
  assert.equal(coolingReason(cooldowns, 'h', 'r2', NOW), null);
  assert.equal(coolingReason(cooldowns, 'h', 'r1', NOW), 'resource-cooldown:forbidden');
  applyFailure(cooldowns, strikes, { host: 'h', kind: 'forbidden' }, ctx('r1', NOW + 1));
  assert.equal(coolingReason(cooldowns, 'h', 'r9', NOW + 2), null, 'same resource twice is one strike');
  applyFailure(cooldowns, strikes, { host: 'h', kind: 'not-found' }, ctx('r2', NOW + 2));
  applyFailure(cooldowns, strikes, { host: 'h', kind: 'forbidden' }, ctx('r3', NOW + 3));
  assert.equal(coolingReason(cooldowns, 'h', 'r9', NOW + 4), 'cooldown:repeated-forbidden');
  applyFailure(cooldowns, strikes, { host: 'x', kind: 'rate-limited', retryAfterSec: 90 }, ctx('r1', NOW));
  assert.equal(cooldowns['h:x'].until, NOW + 90000);
  applyFailure(cooldowns, strikes, { host: 'y', kind: 'timeout' }, ctx('r1', NOW));
  assert.equal(cooldowns['h:y'], undefined, 'timeouts never cool a node down');
  assert.deepEqual(Object.keys(pruneCooldowns(cooldowns, NOW + 7 * 3600 * 1000)), []);
});

test('store: corrupt JSON degrades to empty state and failed writes never throw', () => {
  const backend = memoryBackend({ [S.KEYS.decisions]: '{not json', [S.KEYS.samples]: JSON.stringify({ v: 999, items: { a: {} } }) });
  const store = S.createStore(backend);
  assert.deepEqual(S.loadDecisions(store), { v: 1, items: {}, networks: {} });
  assert.deepEqual(S.loadSamples(store).items, {}, 'unknown schema version is discarded');
  assert.deepEqual(store.problems, [{ key: S.KEYS.decisions, problem: 'corrupt' }]);
  const broken = S.createStore({ read: () => { throw new Error('boom'); }, write: () => { throw new Error('full'); } });
  assert.equal(broken.readJson(S.KEYS.state, 'fallback'), 'fallback');
  assert.equal(broken.writeJson(S.KEYS.state, {}), false);
  assert.equal(broken.problems.length, 2);
  const malformed = S.createStore(memoryBackend({
    [S.KEYS.decisions]: JSON.stringify({ v: 1, items: { ok: { winner: 'a', expiresAt: 1, networkKey: 'n', backups: [1, 'b'] }, bad: { winner: 5 } } }),
  }));
  const d = S.loadDecisions(malformed);
  assert.deepEqual(Object.keys(d.items), ['ok']);
  assert.deepEqual(d.items.ok.backups, ['b']);
});

test('pruneMap keeps the most recent entries', () => {
  const map = {};
  for (let i = 0; i < 10; i++) map['k' + i] = { at: i };
  assert.deepEqual(Object.keys(S.pruneMap(map, 3, 'at')).sort(), ['k7', 'k8', 'k9']);
});

test('logger drops forbidden fields and caps stored events', () => {
  const lines = [];
  const log = createLogger({ now: () => 1, sink: (l) => lines.push(l), debug: true, limit: 2 });
  log.event('probe_rejected', { host: 'h', url: 'https://secret', headers: { Cookie: 'x' }, ssid: 'Home', kind: 'forbidden' });
  log.event('probe_started', { host: 'h' });
  log.event('scheduling_stopped', { reason: 'budget' });
  log.event('run_finished', {});
  assert.equal(log.events.length, 2);
  assert.equal(log.droppedCount(), 1);
  assert.equal(log.counts.probe_started, 1);
  assert.ok(lines.every((l) => !/secret|Cookie|Home/.test(l)));
});
