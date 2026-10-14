'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAction } = require('../../src/app/runner');
const { panelMain } = require('../../src/app/panel');
const { handleRequest } = require('../../src/app/router');
const S = require('../../src/core/state');
const { FakeClock, createCdn, memoryBackend, mediaUrl, NATIVE } = require('../helpers/sim');
const data = require('../../data/cdn-candidates.json');

const WIFI = { wifi: { ssid: 'Home' }, v4: { primaryInterface: 'en0' } };
const CELL = { v4: { primaryInterface: 'pdp_ip0' }, 'cellular-data': { carrier: 'Singtel', radio: 'NR' } };
const WUHAN = 'cn-hbwh-fx-01-12.bilivideo.com';

function world(opts) {
  const o = opts || {};
  const clock = new FakeClock();
  const backend = memoryBackend(o.initial);
  const cdn = createCdn(clock, Object.assign({ [NATIVE]: { mbps: 3, latencyMs: 120 }, [WUHAN]: { mbps: 300, latencyMs: 20 } }, o.behaviors || {}), o.defaults || { mbps: 30, latencyMs: 60 });
  let network = o.network || WIFI;
  const w = {
    clock,
    backend,
    cdn,
    store: () => S.createStore(backend),
    setNetwork: (n) => { network = n; },
    play(url) {
      return handleRequest({
        request: { url: url || mediaUrl(), method: 'GET', headers: { 'User-Agent': 'bili-ios', Range: 'bytes=0-999' } },
        argument: o.argument || '',
        network,
        store: S.createStore(backend),
        now: clock.now,
        httpApi: () => {},
      });
    },
    ctx(extra) {
      return Object.assign({
        trigger: 'button',
        argument: o.argument || '',
        network: () => network,
        store: S.createStore(backend),
        now: clock.now,
        rng: () => 0.5,
        http: cdn.http,
        setTimer: clock.setTimer,
        registryData: data,
      }, extra || {});
    },
    run(action, extra) {
      return clock.drive(runAction(w.ctx(Object.assign({ action }, extra || {}))));
    },
  };
  return w;
}

test('manual quick selection end to end: sample -> probe -> decision -> rewrite', async () => {
  const w = world();
  assert.equal((await w.run('quick')).status, 'no-sample');
  assert.deepEqual(w.play(), {});
  w.play(mediaUrl({ rep: 30280 }));
  const result = await w.run('quick');
  assert.equal(result.status, 'target-reached');
  assert.equal(result.resources.length, 2, 'video and audio of the same playback');
  assert.equal(result.resources[0].mediaType, 'video');
  assert.equal(result.resources[0].winner, WUHAN);
  assert.equal(result.resources[0].committed, true);
  const out = w.play();
  assert.equal(out.headers.Host, WUHAN);
  assert.equal(out.url, mediaUrl().replace(NATIVE, WUHAN));
  // Persisted summary and profile, without signed URLs in the run log.
  const lastRun = w.backend.data[S.KEYS.lastRun];
  assert.ok(lastRun.includes('selection_confirmed'));
  assert.ok(!lastRun.includes('upsig'));
  const state = S.loadState(w.store());
  const profile = Object.values(state.profiles)[0];
  assert.ok(profile.ranking[WUHAN].confirmedMbps > 80);
  assert.ok(profile.ranking[WUHAN].coarseMbps > 0);
  assert.equal(profile.lastFullScanAt, null, 'quick runs never claim a full scan');
  assert.equal(w.backend.data[S.KEYS.lease], undefined, 'lease released');

  // A resource with a valid decision is not measured again.
  const before = w.cdn.calls.length;
  assert.equal((await w.run('quick')).status, 'already-decided');
  assert.equal(w.cdn.calls.length, before);
});

test('a running task blocks a second one (lease)', async () => {
  const w = world();
  w.play();
  w.store().writeJson(S.KEYS.lease, { runId: 'other', expiresAt: w.clock.now() + 60000, action: 'full' });
  const r = await w.run('quick');
  assert.equal(r.status, 'busy');
  assert.equal(w.cdn.calls.length, 0);
});

test('a network change during the run discards the results', async () => {
  const w = world({ behaviors: { [WUHAN]: { mbps: 60 } } });
  w.play();
  const p = runAction(w.ctx({ action: 'quick' }));
  w.clock.setTimer(() => {
    const store = w.store();
    const meta = S.loadMeta(store);
    meta.generation += 1;
    store.writeJson(S.KEYS.meta, meta);
  }, 700);
  const result = await w.clock.drive(p);
  assert.equal(result.resources[0].stopReason, 'network-changed');
  assert.equal(result.resources[0].committed, false);
  assert.deepEqual(S.loadDecisions(w.store()).items, {});
  assert.deepEqual(w.play(), {});
});

test('stop request ends dispatching', async () => {
  const w = world({ behaviors: { [WUHAN]: { mbps: 60 } } });
  w.play();
  const p = runAction(w.ctx({ action: 'quick' }));
  w.clock.setTimer(() => { runAction(w.ctx({ action: 'stop' })); }, 300);
  const result = await w.clock.drive(p);
  assert.equal(result.resources[0].stopReason, 'stopped-by-user');
});

test('full exploration: complete run sets the full-scan time, partial does not', async () => {
  const w = world();
  w.play();
  const full = await w.run('full');
  assert.equal(full.mode, 'full');
  const r = full.resources[0];
  assert.equal(r.complete, true);
  assert.equal(r.coverage.eligible, r.coverage.started);
  assert.ok(r.coverage.eligible >= 299);
  const profile = Object.values(S.loadState(w.store()).profiles)[0];
  assert.ok(profile.lastFullScanAt);

  const slow = world({ defaults: { mbps: 4, latencyMs: 300 } });
  slow.store().writeJson(S.KEYS.config, { runDeadlineSeconds: 10 });
  slow.play();
  const partial = await slow.run('full');
  assert.equal(partial.resources[0].partial, true);
  const p2 = Object.values(S.loadState(slow.store()).profiles)[0];
  assert.equal(p2.lastFullScanAt, null);
  assert.ok(p2.lastFullCoverage.started < p2.lastFullCoverage.eligible);
});

test('cellular: no automatic or full discovery by default, quick uses 4 MiB', async () => {
  const w = world({ network: CELL, argument: 'mode=adaptive' });
  w.play();
  assert.equal((await w.run('auto', { trigger: null })).status, 'cellular-blocked');
  assert.equal((await w.run('full')).status, 'cellular-blocked');
  const quick = await w.run('quick');
  const b = quick.resources[0].budget;
  assert.ok(b.observedBytes + b.unobservableBytes <= 4 * 1024 * 1024);
  assert.ok(w.cdn.peak() <= 2);
});

test('manual mode ignores timer and HTTP-API triggers', async () => {
  const w = world();
  w.play();
  const r = await w.run('auto', { trigger: null });
  assert.equal(r.status, 'manual-mode');
  assert.equal(r.silent, true);
  assert.equal(w.cdn.calls.length, 0);
  const viaShortcut = await w.run('auto', { trigger: 'intent' });
  assert.equal(viaShortcut.status, 'target-reached');
});

test('adaptive auto runs skip recently failed resources', async () => {
  const w = world({ argument: 'mode=adaptive', behaviors: { [NATIVE]: { kind: 'status', status: 403 } } });
  w.play();
  const first = await w.run('auto', { trigger: null });
  assert.equal(first.status, 'native-invalid');
  const again = await w.run('auto', { trigger: null });
  assert.equal(again.status, 'nothing-pending');
});

test('a new candidate revision resets network rankings', async () => {
  const w = world();
  w.play();
  await w.run('quick');
  const state = S.loadState(w.store());
  state.candidateRevision = 'old-list';
  w.store().writeJson(S.KEYS.state, state);
  w.clock.advance(1000);
  const r = await w.run('quick-force');
  assert.ok(r.events.some((e) => e.event === 'cache_invalidated'));
  assert.equal(S.loadState(w.store()).candidateRevision, data.revision);
});

test('clear actions and pause', async () => {
  const w = world();
  w.play();
  await w.run('quick');
  assert.equal((await w.run('pause')).status, 'paused');
  assert.deepEqual(w.play(), {}, 'paused: no rewrite');
  await w.run('resume');
  assert.ok(w.play().url);
  assert.equal((await w.run('clear-network')).status, 'cleared');
  assert.deepEqual(w.play(), {});
  await w.run('clear-all');
  assert.equal(w.backend.data[S.KEYS.samples], undefined);
});

test('panel: periodic refresh never probes; the button runs quick selection', async () => {
  const w = world();
  w.play();
  const idle = await w.clock.drive(panelMain(w.ctx({ trigger: 'auto-interval', panelAction: 'quick' })));
  assert.equal(w.cdn.calls.length, 0);
  assert.match(idle.content, /视频 30080：未选择/);
  const tapped = await w.clock.drive(panelMain(w.ctx({ trigger: 'button', panelAction: 'quick' })));
  assert.ok(w.cdn.calls.length > 0);
  assert.equal(tapped.title, 'B站 CDN');
  assert.equal(tapped.style, 'good');
  assert.match(tapped.content, /cn-hbwh-fx-01-12/);
  assert.match(tapped.content, /覆盖 有效 \d+ \/ 已启动 \d+ \/ 合格 \d+/);
  assert.match(tapped.content, /流量 可见/);
  assert.ok(!tapped.content.includes('Home'), 'no SSID on the panel');
  const empty = world();
  const none = await empty.clock.drive(panelMain(empty.ctx({ trigger: 'button', panelAction: 'quick' })));
  assert.match(none.content, /没有媒体样本/);
});

test('an expired lease from a crashed run does not block a new one', async () => {
  const w = world();
  w.play();
  w.store().writeJson(S.KEYS.lease, { runId: 'crashed', expiresAt: w.clock.now() - 1, action: 'full' });
  assert.equal((await w.run('quick')).status, 'target-reached');
});

test('failing persistent writes never crash a run', async () => {
  const w = world();
  w.play();
  const backend = { read: (k) => w.backend.read(k), write: () => false };
  const r = await w.clock.drive(runAction(w.ctx({ action: 'quick', store: S.createStore(backend) })));
  assert.equal(r.status, 'store-unavailable');
  assert.ok(r.storeProblems.some((p) => p.problem === 'write-failed'));
  assert.equal(w.cdn.calls.length, 0, 'no probing without a writable lease');
});

test('without a region table the run stays a budget-bounded quick selection', async () => {
  const w = world({ argument: 'mode=adaptive&region=NONE', defaults: { mbps: 20, latencyMs: 60 } });
  w.play();
  const r = await w.run('auto', { trigger: null });
  assert.equal(r.mode, 'quick');
  const res = r.resources[0];
  assert.ok(res.shortlist.size <= 5, 'native + exploration only');
  assert.ok(res.coverage.started < 299);
  const b = res.budget;
  assert.ok(b.observedBytes + b.unobservableBytes <= 12 * 1024 * 1024);
  const profile = Object.values(S.loadState(w.store()).profiles)[0];
  assert.equal(profile.lastFullScanAt, null);
});

test('automatic full exploration backs off after a partial run', async () => {
  const w = world({ argument: 'mode=adaptive', defaults: { mbps: 4, latencyMs: 300 } });
  w.store().writeJson(S.KEYS.config, { automaticFullDiscovery: true, runDeadlineSeconds: 10 });
  w.play();
  const first = await w.run('auto', { trigger: null });
  assert.equal(first.mode, 'full');
  assert.equal(first.resources[0].partial, true);
  w.clock.advance(31000);
  w.play(mediaUrl({ rep: 30064 }));
  const second = await w.run('auto', { trigger: null });
  assert.equal(second.mode, 'quick');
});

test('clearing a network is refused while a task holds the lease', async () => {
  const w = world();
  w.store().writeJson(S.KEYS.lease, { runId: 'r', expiresAt: w.clock.now() + 60000, action: 'full' });
  assert.equal((await w.run('clear-network')).status, 'busy');
});
