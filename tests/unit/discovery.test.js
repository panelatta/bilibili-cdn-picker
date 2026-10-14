'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DiscoverySession } = require('../../src/core/discovery');
const { resolveConfig } = require('../../src/core/config');
const { buildRegistry, regionHosts } = require('../../src/core/candidates');
const { FakeClock, createCdn, mediaUrl, NATIVE } = require('../helpers/sim');
const data = require('../../data/cdn-candidates.json');

const MiB = 1024 * 1024;
const registry = buildRegistry(data);
const SG = regionHosts(registry, 'SG');
const WUHAN = 'cn-hbwh-fx-01-12.bilivideo.com';

function session(clock, cdn, opts) {
  const o = opts || {};
  const config = resolveConfig(o.argument || '', o.overrides || null).config;
  return new DiscoverySession({
    mode: o.mode || 'quick',
    config,
    sample: { url: mediaUrl(), headers: { 'User-Agent': 'bili' }, nativeHost: NATIVE },
    http: cdn.http,
    now: clock.now,
    setTimer: clock.setTimer,
    deadlineAt: clock.now() + (o.deadlineMs || 60000),
    shouldAbort: o.shouldAbort,
    targetMbps: o.targetMbps || config.targetMbps,
    cellular: !!o.cellular,
    budgetBytes: (o.budgetMiB || (o.mode === 'full' ? 100 : 12)) * MiB,
    onProvisional: o.onProvisional,
    runId: 'test',
  });
}

function sgShortlist() {
  return [NATIVE].concat(SG, registry.diversityOrder.filter((h) => SG.indexOf(h) < 0).slice(0, 4));
}

test('quick mode: confirmed fast node wins and stops at the target', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, {
    [NATIVE]: { mbps: 3, latencyMs: 120 },
    [WUHAN]: { mbps: 300, latencyMs: 30 },
    'cn-hk-eq-01-14.bilivideo.com': { mbps: 1, latencyMs: 150 },
  }, { mbps: 40, latencyMs: 60 });
  const s = session(clock, cdn);
  const result = await clock.drive(s.runQuick(sgShortlist(), () => []));
  assert.equal(result.status, 'target-reached');
  assert.equal(result.winner.host, WUHAN);
  assert.ok(result.winner.score >= 80);
  assert.equal(result.stopReason, 'target-reached');
  assert.equal(result.enoughFast, true);
  // preflight + 14 coarse + 3 refine + 1 confirm
  const stages = result.stages.map((x) => x.stage);
  assert.deepEqual(stages, ['preflight', 'coarse', 'refine', 'confirm']);
  assert.equal(result.coverage.started, 15);
  assert.ok(cdn.peak() <= 4, 'quick Wi-Fi concurrency 4');
  const b = result.budget;
  assert.ok(b.observedBytes + b.unobservableBytes <= 12 * MiB);
  // Every probe carried the marker and its own Range; native URL path kept.
  cdn.calls.forEach((c) => {
    assert.equal(c.headers['X-BCP-Probe'], 'test');
    assert.ok(c.options.url.endsWith(mediaUrl().slice(mediaUrl().indexOf('/upgcxcode/'))));
  });
  // Confirm reads a different comparable range than refine.
  const confirm = cdn.calls[cdn.calls.length - 1];
  assert.equal(confirm.start, 1048576);
  assert.equal(confirm.end, 2 * 1048576 - 1);
});

test('a fast coarse sample alone can never trigger the early stop', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, {
    [NATIVE]: { mbps: 20, latencyMs: 40 },
    // Very fast first bytes, but large transfers stall.
    [WUHAN]: { mbps: 900, latencyMs: 5, failAbove: 200 * 1024 },
  }, { mbps: 10, latencyMs: 80 });
  const s = session(clock, cdn);
  const result = await clock.drive(s.runQuick(sgShortlist(), () => []));
  assert.notEqual(result.winner && result.winner.host, WUHAN);
  assert.ok(result.measurements[WUHAN].coarse);
  assert.equal(result.measurements[WUHAN].confirm, undefined);
  assert.notEqual(result.status, 'target-reached');
});

test('below target: provisional winner first, then budget-bounded expansion', async () => {
  const clock = new FakeClock();
  const provisional = [];
  const cdn = createCdn(clock, { [NATIVE]: { mbps: 4, latencyMs: 100 } }, { mbps: 30, latencyMs: 50 });
  const s = session(clock, cdn, { onProvisional: (w) => provisional.push(w.host) });
  const order = registry.diversityOrder;
  let cursor = 0;
  const nextBatch = (count, untested) => {
    const out = [];
    while (out.length < count && cursor < order.length) {
      const h = order[cursor++];
      if (untested(h)) out.push(h);
    }
    return out;
  };
  const result = await clock.drive(s.runQuick(sgShortlist(), nextBatch));
  assert.equal(result.status, 'selected');
  assert.ok(provisional.length >= 1, 'playable node committed before expansion');
  assert.equal(result.stopReason, 'budget');
  const b = result.budget;
  assert.ok(b.observedBytes + b.unobservableBytes + b.outstandingBytes <= 12 * MiB);
  assert.ok(result.coverage.started > 15, 'expansion probed beyond the shortlist');
});

test('native 403 marks the sample invalid and stops immediately', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, { [NATIVE]: { kind: 'status', status: 403 } });
  const s = session(clock, cdn);
  const result = await clock.drive(s.runQuick(sgShortlist(), () => ['x']));
  assert.equal(result.status, 'native-invalid');
  assert.equal(cdn.calls.length, 1);
});

test('everything timing out: one rescue round, then no valid result', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, {}, { kind: 'timeout' });
  const s = session(clock, cdn);
  const result = await clock.drive(s.runQuick(sgShortlist(), () => []));
  assert.equal(result.status, 'no-valid');
  assert.equal(result.winner, null);
  const rescue = result.stages.find((x) => x.stage === 'rescue');
  assert.ok(rescue && rescue.dispatched <= 4);
  assert.equal(cdn.calls.find((c) => c.timeoutMs === 1500).host, NATIVE, 'rescue starts with native');
  assert.ok(result.budget.unobservableCount > 0, 'timeouts stay unobservable');
});

test('network change stops dispatching and is reported', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, {}, { mbps: 30, latencyMs: 50 });
  let calls = 0;
  const s = session(clock, cdn, { shouldAbort: () => (++calls > 4 ? 'network-changed' : null) });
  const result = await clock.drive(s.runQuick(sgShortlist(), () => []));
  assert.equal(result.stopReason, 'network-changed');
  assert.ok(cdn.calls.length < 15);
});

test('rejected samples (range ignored, HTML, redirect) never rank', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, {
    [NATIVE]: { mbps: 5 },
    [SG[0]]: { kind: 'full', mbps: 500, objectLength: 2 * MiB },
    [SG[1]]: { kind: 'html', mbps: 500 },
    [SG[2]]: { kind: 'redirect' },
    [SG[3]]: { kind: 'wrong-range', mbps: 500 },
    [SG[4]]: { kind: 'short-body', mbps: 500 },
  }, { mbps: 25 });
  const s = session(clock, cdn);
  const result = await clock.drive(s.runQuick([NATIVE].concat(SG), () => []));
  for (const h of SG.slice(0, 5)) {
    assert.equal(result.measurements[h] && result.measurements[h].coarse, undefined, h);
  }
  const kinds = result.failures.map((f) => f.kind).sort();
  assert.ok(kinds.includes('range-ignored'));
  assert.equal(result.stopReason, 'unsafe-response', 'do not continue scanning after an unbounded response');
  assert.ok(result.budget.overrunCount >= 1, 'Range-ignoring host overran its reservation');
  assert.ok(![SG[0], SG[1], SG[2], SG[3], SG[4]].includes(result.winner && result.winner.host));
});

test('native stays when the winner is not clearly better', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, { [NATIVE]: { mbps: 50, latencyMs: 10 }, [SG[0]]: { mbps: 55, latencyMs: 10 } }, { mbps: 5, latencyMs: 200 });
  const s = session(clock, cdn, { targetMbps: 30 });
  const result = await clock.drive(s.runQuick([NATIVE, SG[0], SG[1]], () => []));
  assert.equal(result.winner.host, NATIVE);
  assert.equal(result.winner.reason, 'native-competitive');
});

test('objects shorter than the coarse range use one consistent shorter range', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, {}, { mbps: 100, latencyMs: 10, objectLength: 100 * 1024 });
  const s = session(clock, cdn, { targetMbps: 1 });
  const result = await clock.drive(s.runQuick([NATIVE, SG[0], SG[1]], () => []));
  assert.equal(result.objectLength, 100 * 1024);
  cdn.calls.slice(1).forEach((c) => assert.equal(c.end, 100 * 1024 - 1));
  assert.ok(result.winner);
  const tiny = new FakeClock();
  const cdn2 = createCdn(tiny, {}, { objectLength: 10 * 1024 });
  const r2 = await tiny.drive(session(tiny, cdn2).runQuick([NATIVE, SG[0]], () => []));
  assert.equal(r2.status, 'object-too-small');
});

test('cellular quick mode: 4 MiB budget, concurrency 2, confirmation reserved', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, { [WUHAN]: { mbps: 60 } }, { mbps: 20, latencyMs: 60 });
  const s = session(clock, cdn, { cellular: true, budgetMiB: 4 });
  const result = await clock.drive(s.runQuick(sgShortlist(), () => []));
  const b = result.budget;
  assert.ok(b.observedBytes + b.unobservableBytes <= 4 * MiB);
  assert.ok(cdn.peak() <= 2);
  assert.ok(result.stages.some((x) => x.stage === 'confirm'), 'budget for confirmation was kept back');
  assert.ok(result.winner);
});

test('insufficient budget never upgrades a coarse result to confirmed', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, {}, { mbps: 100 });
  const s = session(clock, cdn, { budgetMiB: 1 });
  const result = await clock.drive(s.runQuick(sgShortlist(), () => []));
  assert.equal(result.status, 'insufficient-budget');
  assert.equal(cdn.calls.length, 0);
});

test('full exploration covers all 299 candidates and confirms the top 5', async () => {
  const clock = new FakeClock();
  const behaviors = {};
  registry.diversityOrder.forEach((h, i) => {
    behaviors[h] = { mbps: 5 + ((i * 37) % 97), latencyMs: 20 + ((i * 13) % 200) };
  });
  behaviors[WUHAN] = { mbps: 400, latencyMs: 15 };
  const cdn = createCdn(clock, behaviors, { mbps: 10 });
  const s = session(clock, cdn, { mode: 'full' });
  const ordered = [NATIVE].concat(registry.diversityOrder);
  const result = await clock.drive(s.runFull(ordered));
  assert.equal(result.complete, true);
  assert.equal(result.partial, false);
  // The native host is also in the global list: counted once.
  assert.equal(result.coverage.eligible, 299);
  assert.equal(result.coverage.started, 299);
  assert.equal(result.winner.host, WUHAN);
  const refine = result.stages.find((x) => x.stage === 'refine');
  const confirm = result.stages.find((x) => x.stage === 'confirm');
  assert.equal(refine.dispatched, 20);
  assert.equal(confirm.dispatched, 5);
  assert.ok(cdn.peak() <= 8);
  const b = result.budget;
  assert.ok(b.observedBytes + b.unobservableBytes <= 100 * MiB);
  assert.ok(result.durationMs < 60000);
});

test('full exploration reserves later stages and reports partial coverage', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, {}, { mbps: 2, latencyMs: 300 });
  const s = session(clock, cdn, { mode: 'full', deadlineMs: 8000 });
  const result = await clock.drive(s.runFull([NATIVE].concat(registry.diversityOrder)));
  assert.equal(result.complete, false);
  assert.equal(result.partial, true);
  assert.ok(result.coverage.started < 300);
  assert.equal(result.stopReason, 'phase-budget');
});

test('iOS full exploration with many timeouts still confirms a usable candidate', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, { [NATIVE]: { kind: 'ok', mbps: 100, latencyMs: 20 }, [WUHAN]: { kind: 'ok', mbps: 300, latencyMs: 10 } }, { kind: 'timeout' });
  const s = session(clock, cdn, { mode: 'full', overrides: { discoveryConcurrency: 2, refineConcurrency: 1, confirmConcurrency: 1 } });
  const result = await clock.drive(s.runFull([WUHAN].concat(registry.diversityOrder)));
  assert.ok(result.winner && result.winner.score > 80);
  assert.ok(result.stages.find((x) => x.stage === 'confirm').dispatched > 0);
  assert.equal(result.partial, true);
  assert.equal(result.complete, false);
  assert.equal(result.stopReason, 'phase-budget');
  assert.ok(result.coverage.started < result.coverage.eligible);
  assert.ok(result.durationMs < 60000);
  assert.ok(cdn.peak() <= 2);
  const confirm = cdn.calls.find((c) => c.end - c.start + 1 === 4 * MiB);
  assert.ok(confirm, 'retain the original 4 MiB confirmation, not a smaller substitute');
});

test('full exploration stops exactly when the budget is exhausted', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, {}, { mbps: 80, latencyMs: 20 });
  const s = session(clock, cdn, { mode: 'full', budgetMiB: 10, overrides: { discoveryTargetMiB: 10 } });
  const result = await clock.drive(s.runFull([NATIVE].concat(registry.diversityOrder)));
  assert.equal(result.partial, true);
  assert.equal(result.stopReason, 'budget');
  const b = result.budget;
  assert.ok(b.observedBytes + b.unobservableBytes <= 10 * MiB);
});

test('runs finish for 0, 1, 19, 20, 21 and 300+ candidates', async () => {
  const pool = registry.diversityOrder.concat(Array.from({ length: 20 }, (_, i) => 'cn-extra-' + i + '.bilivideo.com'));
  for (const n of [0, 1, 19, 20, 21, 319]) {
    for (const mode of ['quick', 'full']) {
      const clock = new FakeClock();
      const cdn = createCdn(clock, {}, { mbps: 40, latencyMs: 30 });
      const s = session(clock, cdn, { mode });
      const hosts = pool.slice(0, n);
      const result = await clock.drive(mode === 'quick' ? s.runQuick([NATIVE].concat(hosts.slice(0, 19)), () => []) : s.runFull(hosts));
      assert.ok(result.status, n + ' ' + mode);
      assert.ok(result.coverage.started >= 1);
      if (mode === 'full') assert.equal(result.coverage.eligible, new Set([NATIVE].concat(hosts)).size);
    }
  }
});

test('an unconfirmed native sample never displaces a confirmed winner', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, {
    // Fast 1 MiB refine, but every confirm read times out.
    [NATIVE]: { mbps: 120, latencyMs: 5, failFrom: 1048576 },
    [SG[0]]: { mbps: 77, latencyMs: 5 },
  }, { mbps: 5, latencyMs: 200 });
  const s = session(clock, cdn);
  const result = await clock.drive(s.runQuick([NATIVE, SG[0], SG[1]], () => []));
  assert.equal(result.winner.host, SG[0]);
  assert.ok(result.winner.score < 80);
  assert.equal(result.enoughFast, false);
  assert.equal(result.status, 'selected');
  const nativeConfirms = cdn.calls.filter((c) => c.host === NATIVE && c.start === 1048576);
  assert.equal(nativeConfirms.length, 1, 'a failed native confirm is not retried');
});

test('a displaced winner stays available as a confirmed backup', async () => {
  const clock = new FakeClock();
  const cdn = createCdn(clock, { [NATIVE]: { mbps: 60, latencyMs: 10 }, [SG[0]]: { mbps: 66, latencyMs: 10 } }, { mbps: 5, latencyMs: 200 });
  const s = session(clock, cdn, { targetMbps: 30 });
  const result = await clock.drive(s.runQuick([NATIVE, SG[0]], () => []));
  assert.equal(result.winner.host, NATIVE);
  assert.ok(result.backups.some((b) => b.host === SG[0] && b.confirmed));
});


test('quick and full modes exclude failed confirmations and unconfirmed nodes from backups', async () => {
  const bad = SG[1];
  for (const mode of ['quick', 'full']) {
    const clock = new FakeClock();
    const cdn = createCdn(clock, {
      [NATIVE]: { mbps: 3, latencyMs: 120 },
      [WUHAN]: { mbps: 300, latencyMs: 20 },
      [bad]: { mbps: 600, latencyMs: 10, failFrom: 1048576 },
    }, { mbps: 30, latencyMs: 60 });
    const s = session(clock, cdn, { mode });
    const result = await clock.drive(mode === 'full' ? s.runFull(sgShortlist()) : s.runQuick(sgShortlist(), () => []));
    assert.equal(result.winner.host, WUHAN);
    assert.ok(result.measurements[bad].confirmFailed);
    assert.equal(s.scoreOf(bad), null);
    assert.ok(!result.backups.some((b) => b.host === bad));
    result.backups.forEach((b) => { assert.equal(b.confirmed, true); assert.ok(s.scoreOf(b.host) > 0); });
  }
});
