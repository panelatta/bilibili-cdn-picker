'use strict';

// Target traffic budget (design §9.2). Every dispatch reserves its Range size
// first, so parallel workers never all believe the budget is still free.
// Completed responses settle with their actual byte length. Errors and
// timeouts keep the conservative reservation and count as unobservable: the
// completion-callback client cannot report partially received bytes.
// This is a target budget, not a hard cap (a server ignoring Range can send
// more than requested before the callback fires).

class Budget {
  constructor(limitBytes) {
    this.limitBytes = Math.max(0, limitBytes || 0);
    this.observedBytes = 0;
    this.outstandingBytes = 0;
    this.unobservableBytes = 0;
    this.unobservableCount = 0;
    this.overrunCount = 0;
    this.nextId = 1;
  }

  committed() {
    return this.observedBytes + this.outstandingBytes + this.unobservableBytes;
  }

  remaining() {
    return Math.max(0, this.limitBytes - this.committed());
  }

  // keepBack: bytes that must stay available for later stages.
  canReserve(bytes, keepBack) {
    return bytes > 0 && this.committed() + bytes + (keepBack || 0) <= this.limitBytes;
  }

  reserve(bytes, keepBack) {
    if (!this.canReserve(bytes, keepBack)) return null;
    this.outstandingBytes += bytes;
    return { id: this.nextId++, bytes, settled: false };
  }

  // actualBytes === null means the transferred amount is not observable.
  settle(token, actualBytes) {
    if (!token || token.settled) return;
    token.settled = true;
    this.outstandingBytes -= token.bytes;
    if (actualBytes === null || actualBytes === undefined || !(actualBytes >= 0)) {
      this.unobservableBytes += token.bytes;
      this.unobservableCount++;
      return;
    }
    if (actualBytes > token.bytes) this.overrunCount++;
    this.observedBytes += actualBytes;
  }

  report() {
    return {
      limitBytes: this.limitBytes,
      observedBytes: this.observedBytes,
      outstandingBytes: this.outstandingBytes,
      unobservableBytes: this.unobservableBytes,
      unobservableCount: this.unobservableCount,
      overrunCount: this.overrunCount,
      exhausted: this.remaining() <= 0,
    };
  }
}

module.exports = { Budget };
