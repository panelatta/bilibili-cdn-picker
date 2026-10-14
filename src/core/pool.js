'use strict';

// Rolling worker pool (design §7.3). A worker is released only when the real
// HTTP callback arrives; there is no batch barrier inside a stage and no
// logical timeout that frees a slot early. `RequestPool` counts every real
// in-flight request of the whole script run, so abandoned requests from an
// earlier stage still occupy Surge's 20-request budget.

const SURGE_MAX_INFLIGHT = 20;

class RequestPool {
  constructor(hardLimit) {
    this.hardLimit = Math.min(SURGE_MAX_INFLIGHT, Math.max(1, hardLimit || SURGE_MAX_INFLIGHT));
    this.active = 0;
    this.peak = 0;
  }

  acquire() {
    this.active++;
    if (this.active > this.peak) this.peak = this.active;
  }

  release() {
    this.active--;
  }
}

// opts:
//   pool, items, concurrency
//   launch(item, index) -> {promise} | {skip: reason} | {stop: reason}
//   shouldStop() -> reason | null       (checked before every dispatch)
//   onResult(result, item)               (may make shouldStop return a reason)
//   hardStopAfterMs, setTimer            (watchdog if callbacks never arrive)
function runStage(opts) {
  const items = opts.items || [];
  const concurrency = Math.max(1, opts.concurrency || 1);
  const pool = opts.pool;
  const setTimer = opts.setTimer || setTimeout;
  return new Promise((resolve) => {
    let next = 0;
    let inStage = 0;
    let stopReason = null;
    let finished = false;
    let dispatched = 0;
    const skipped = [];

    function finish(reason) {
      if (finished) return;
      finished = true;
      resolve({ stopReason: reason, dispatched, abandoned: inStage, skipped, remaining: items.length - next });
    }

    function settle(result, item) {
      inStage--;
      pool.release();
      if (finished) return;
      try {
        opts.onResult(result, item);
      } catch (e) {
        stopReason = stopReason || 'internal-error';
      }
      pump();
    }

    function pump() {
      if (finished) return;
      while (!stopReason && next < items.length && inStage < concurrency && pool.active < pool.hardLimit) {
        const reason = opts.shouldStop ? opts.shouldStop() : null;
        if (reason) {
          stopReason = reason;
          break;
        }
        const item = items[next];
        const handle = opts.launch(item, next) || { skip: 'no-handle' };
        if (handle.stop) {
          stopReason = handle.stop;
          break;
        }
        next++;
        if (handle.skip) {
          skipped.push({ item, reason: handle.skip });
          continue;
        }
        inStage++;
        dispatched++;
        pool.acquire();
        handle.promise.then(
          (result) => settle(result, item),
          (error) => settle({ ok: false, kind: 'internal', error: String(error), host: item && item.host }, item)
        );
      }
      if (inStage === 0) {
        if (stopReason) finish(stopReason);
        else if (next >= items.length) finish('exhausted');
        else if (pool.active >= pool.hardLimit) finish('pool-saturated');
      }
    }

    if (opts.hardStopAfterMs > 0) {
      setTimer(() => finish('deadline'), opts.hardStopAfterMs);
    }
    pump();
  });
}

module.exports = { RequestPool, runStage, SURGE_MAX_INFLIGHT };
