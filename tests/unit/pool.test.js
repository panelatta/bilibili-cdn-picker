'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestPool, runStage } = require('../../src/core/pool');
const { FakeClock } = require('../helpers/sim');

// Each item resolves after `durationMs` of virtual time.
function launcher(clock, durations, log) {
  return (item, index) => {
    const startedAt = clock.now();
    log.push({ host: item.host, startedAt, index });
    return {
      promise: new Promise((resolve) => {
        clock.setTimer(() => resolve({ host: item.host, ok: true, elapsedMs: clock.now() - startedAt, startedAt, doneAt: clock.now() }), durations[item.host]);
      }),
    };
  };
}

test('rolling workers: a slot is refilled as soon as its callback arrives', async () => {
  const clock = new FakeClock();
  const durations = { a: 300, b: 100, c: 100, d: 50 };
  const log = [];
  const results = [];
  const pool = new RequestPool(20);
  const out = await clock.drive(
    runStage({
      pool,
      items: ['a', 'b', 'c', 'd'].map((host) => ({ host })),
      concurrency: 2,
      launch: launcher(clock, durations, log),
      onResult: (r) => results.push(r),
      setTimer: clock.setTimer,
    })
  );
  assert.equal(out.stopReason, 'exhausted');
  const t0 = log[0].startedAt;
  assert.deepEqual(log.map((x) => [x.host, x.startedAt - t0]), [['a', 0], ['b', 0], ['c', 100], ['d', 200]]);
  // Ranking by own elapsed time, not global completion order: d started late
  // but is fastest; a finished at 300 ms but is slowest.
  const ranked = results.slice().sort((x, y) => x.elapsedMs - y.elapsedMs).map((r) => r.host);
  assert.deepEqual(ranked, ['d', 'b', 'c', 'a']);
  assert.equal(pool.active, 0);
  assert.equal(pool.peak, 2);
});

test('early stop: no new dispatch after the condition, in-flight requests drain', async () => {
  const clock = new FakeClock();
  const durations = { a: 50, b: 400, c: 60, d: 60, e: 60 };
  const log = [];
  const results = [];
  let stop = null;
  const out = await clock.drive(
    runStage({
      pool: new RequestPool(20),
      items: ['a', 'b', 'c', 'd', 'e'].map((host) => ({ host })),
      concurrency: 2,
      shouldStop: () => stop,
      launch: launcher(clock, durations, log),
      onResult: (r) => {
        results.push(r);
        if (r.host === 'c') stop = 'target-reached';
      },
      setTimer: clock.setTimer,
    })
  );
  assert.equal(out.stopReason, 'target-reached');
  assert.deepEqual(log.map((x) => x.host), ['a', 'b', 'c']);
  // b was in flight when the stop fired; its real callback was still awaited.
  assert.deepEqual(results.map((r) => r.host).sort(), ['a', 'b', 'c']);
});

test('a slot stays occupied until the real callback, never a logical timeout', async () => {
  const clock = new FakeClock();
  const durations = { slow: 2000, x: 10, y: 10 };
  const log = [];
  const pool = new RequestPool(2);
  const out = await clock.drive(
    runStage({
      pool,
      items: ['slow', 'x', 'y'].map((host) => ({ host })),
      concurrency: 5,
      launch: launcher(clock, durations, log),
      onResult: () => {},
      setTimer: clock.setTimer,
    })
  );
  assert.equal(out.stopReason, 'exhausted');
  assert.equal(pool.peak, 2, 'hard in-flight limit respected');
  assert.equal(log[2].startedAt - log[0].startedAt, 10);
});

test('watchdog ends a stage whose callbacks never arrive, keeping the slots counted', async () => {
  const clock = new FakeClock();
  const pool = new RequestPool(20);
  const out = await clock.drive(
    runStage({
      pool,
      items: [{ host: 'hang' }],
      concurrency: 1,
      launch: () => ({ promise: new Promise(() => {}) }),
      onResult: () => {},
      hardStopAfterMs: 5000,
      setTimer: clock.setTimer,
    })
  );
  assert.equal(out.stopReason, 'deadline');
  assert.equal(out.abandoned, 1);
  assert.equal(pool.active, 1);
});

test('launch can stop (budget) or skip items', async () => {
  const clock = new FakeClock();
  const log = [];
  const out = await clock.drive(
    runStage({
      pool: new RequestPool(20),
      items: ['a', 'b', 'c', 'd'].map((host) => ({ host })),
      concurrency: 4,
      launch: (item, i) => (item.host === 'b' ? { skip: 'bad' } : item.host === 'd' ? { stop: 'budget' } : launcher(clock, { a: 5, c: 5 }, log)(item, i)),
      onResult: () => {},
      setTimer: clock.setTimer,
    })
  );
  assert.equal(out.stopReason, 'budget');
  assert.equal(out.dispatched, 2);
  assert.equal(out.skipped.length, 1);
});

test('empty stage finishes immediately', async () => {
  const out = await runStage({ pool: new RequestPool(), items: [], concurrency: 3, launch: () => null, onResult: () => {} });
  assert.equal(out.stopReason, 'exhausted');
});
