'use strict';

// Dynamic elimination line (design §7.4), kept per stage because each stage
// uses a different Range size:
//   cutoffMs = clamp(alpha × kthBestElapsedMs, minMs, maxMs)
// It only sets the timeout of requests dispatched later; in-flight requests
// keep their original timeout. Every `looseEvery`-th dispatch still uses the
// initial timeout so slow-start but fast-transfer nodes get a fair chance.

class CutoffTracker {
  constructor(options) {
    const o = options || {};
    this.initialMs = o.initialMs;
    this.minMs = Math.min(o.minMs, o.initialMs);
    this.maxMs = Math.max(o.maxMs || o.initialMs, this.minMs);
    this.alpha = o.alpha || 2.5;
    this.k = Math.max(1, o.k || 1);
    this.looseEvery = o.looseEvery || 0;
    this.elapsed = [];
  }

  record(elapsedMs) {
    if (!(elapsedMs >= 0)) return;
    let i = this.elapsed.length;
    while (i > 0 && this.elapsed[i - 1] > elapsedMs) i--;
    this.elapsed.splice(i, 0, elapsedMs);
  }

  kthBest() {
    return this.elapsed.length >= this.k ? this.elapsed[this.k - 1] : null;
  }

  timeoutFor(dispatchIndex) {
    if (this.looseEvery > 0 && dispatchIndex % this.looseEvery === this.looseEvery - 1) return this.initialMs;
    const kth = this.kthBest();
    if (kth === null) return this.initialMs;
    return Math.round(Math.min(this.maxMs, Math.max(this.minMs, this.alpha * kth)));
  }
}

module.exports = { CutoffTracker };
