'use strict';

const { Budget } = require('./budget');
const { CutoffTracker } = require('./cutoff');
const { RequestPool, runStage } = require('./pool');
const { buildProbeRequest, evaluateProbe } = require('./probe');
const { KiB } = require('./format');

// Staged discovery for one media resource (design §6-§7):
//   native preflight -> coarse (small Range, rolling, dynamic cutoff)
//   -> refine (1 MiB) -> confirm (quick: 1 MiB serial, full: 4 MiB serial).
// Only confirmed results can select a winner or trigger the early stop.
// Results are returned to the caller, which validates task identity before
// committing anything.

const MIN_OBJECT_BYTES = 64 * KiB;
const DEADLINE_MARGIN_MS = 250;
const NATIVE_FATAL = { forbidden: true, 'not-found': true };

function defaultTimer(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function byElapsed(a, b) {
  return a.elapsedMs - b.elapsedMs || a.order - b.order;
}

function byMbps(a, b) {
  return b.mbps - a.mbps || a.order - b.order;
}

class DiscoverySession {
  constructor(p) {
    this.mode = p.mode === 'full' ? 'full' : 'quick';
    this.config = p.config;
    this.sample = p.sample;
    this.nativeHost = p.sample.nativeHost;
    this.http = p.http;
    this.now = p.now || Date.now;
    this.setTimer = p.setTimer || defaultTimer;
    this.deadlineAt = p.deadlineAt;
    this.shouldAbort = p.shouldAbort || (() => null);
    this.log = p.log || (() => {});
    this.runId = p.runId || 'run';
    this.targetMbps = p.targetMbps;
    this.cellular = !!p.cellular;
    this.onProvisional = p.onProvisional || null;
    this.budget = new Budget(p.budgetBytes);
    this.pool = p.pool || new RequestPool(20);
    this.objectLength = null;
    this.order = 0;
    this.measurements = {};
    this.failures = [];
    this.coarseStarted = {};
    this.coarseValid = {};
    this.stages = [];
    this.nativeInvalid = false;
    this.startedAt = this.now();
  }

  // ---- probe plumbing -------------------------------------------------------

  abortReason(timeoutMs) {
    const external = this.shouldAbort();
    if (external) return external;
    if (this.now() + (timeoutMs || 0) + DEADLINE_MARGIN_MS > this.deadlineAt) return 'deadline';
    return null;
  }

  clampRange(start, bytes) {
    if (this.objectLength === null) return bytes;
    return Math.max(0, Math.min(bytes, this.objectLength - start));
  }

  launchProbe(host, stage, rangeStart, rangeBytes, timeoutMs, keepBack) {
    const stop = this.abortReason(timeoutMs);
    if (stop) return { stop };
    if (rangeBytes <= 0) return { skip: 'empty-range' };
    const token = this.budget.reserve(rangeBytes, keepBack);
    if (!token) return { stop: 'budget' };
    const options = buildProbeRequest({
      sampleUrl: this.sample.url,
      sampleHeaders: this.sample.headers,
      host,
      rangeStart,
      rangeBytes,
      timeoutMs,
      config: this.config,
      runId: this.runId,
    });
    if (!options) {
      this.budget.settle(token, 0);
      return { skip: 'bad-sample-url' };
    }
    if (stage === 'coarse' || stage === 'preflight' || stage === 'rescue') this.coarseStarted[host] = true;
    const spec = { host, stage, rangeStart, rangeBytes, timeoutMs, startedAt: this.now(), order: this.order++ };
    this.log('probe_started', { stage, host, bytes: rangeBytes, timeoutMs });
    const promise = Promise.resolve()
      .then(() => this.http(options))
      .then(
        (outcome) => outcome || { error: 'empty outcome' },
        (error) => ({ error: String(error) })
      )
      .then((outcome) => {
        const result = evaluateProbe(spec, {
          error: outcome.error,
          response: outcome.response,
          data: outcome.data,
          completedAt: this.now(),
        });
        // Without a response the transferred amount is unknown: keep the
        // conservative reservation instead of inventing a byte count.
        this.budget.settle(token, result.status === null ? null : result.bytes);
        this.record(result);
        return result;
      });
    return { promise };
  }

  record(result) {
    const m = this.measurements[result.host] || (this.measurements[result.host] = { attempts: 0, successes: 0 });
    m.attempts++;
    m.lastKind = result.kind;
    if (result.objectLength && this.objectLength === null) this.objectLength = result.objectLength;
    if (result.ok) {
      m.successes++;
      const entry = { mbps: result.mbps, elapsedMs: result.elapsedMs, bytes: result.bytes, order: result.order };
      if (result.stage === 'refine') m.refine = entry;
      else if (result.stage === 'confirm') { m.confirm = entry; m.confirmFailed = false; }
      else {
        if (!m.coarse || entry.elapsedMs < m.coarse.elapsedMs) m.coarse = entry;
        this.coarseValid[result.host] = true;
      }
      this.log('probe_completed', {
        stage: result.stage, host: result.host, elapsedMs: result.elapsedMs, bytes: result.bytes, mbps: result.mbps,
      });
    } else {
      if (result.stage === 'confirm') { m.confirmFailed = true; delete m.confirm; }
      if (result.kind !== 'timeout' && result.kind !== 'short-object') {
        this.failures.push({ host: result.host, kind: result.kind, status: result.status, retryAfterSec: result.retryAfterSec });
      }
      this.log('probe_rejected', {
        stage: result.stage, host: result.host, elapsedMs: result.elapsedMs, kind: result.kind, status: result.status,
      });
    }
  }

  async stage(params) {
    const name = params.name;
    const results = [];
    let stopFlag = null;
    const tracker = params.cutoff || null;
    const outcome = await runStage({
      pool: this.pool,
      items: params.hosts.map((host) => ({ host })),
      concurrency: params.concurrency,
      shouldStop: () => stopFlag,
      launch: (item, index) => {
        const timeoutMs = tracker ? tracker.timeoutFor(index) : params.timeoutMs;
        const start = typeof params.rangeStart === 'function' ? params.rangeStart(item.host) : params.rangeStart || 0;
        const bytes = this.clampRange(start, params.rangeBytes);
        return this.launchProbe(item.host, name, start, bytes, timeoutMs, params.keepBack || 0);
      },
      onResult: (result) => {
        results.push(result);
        if (result.ok && tracker) tracker.record(result.elapsedMs);
        if (params.onResult) {
          const reason = params.onResult(result);
          if (reason) stopFlag = reason;
        }
      },
      hardStopAfterMs: Math.max(1000, this.deadlineAt + 5000 - this.now()),
      setTimer: this.setTimer,
    });
    const summary = {
      stage: name,
      dispatched: outcome.dispatched,
      valid: results.filter((r) => r.ok).length,
      stopReason: outcome.stopReason,
      abandoned: outcome.abandoned,
    };
    this.stages.push(summary);
    if (outcome.stopReason !== 'exhausted') {
      this.log('scheduling_stopped', { stage: name, reason: outcome.stopReason, dispatched: outcome.dispatched });
    }
    return { results, outcome, summary };
  }

  // ---- shared phases --------------------------------------------------------

  async preflight(keepBack) {
    const bytes = this.config.coarseKiB * KiB;
    const { results, outcome } = await this.stage({
      name: 'preflight',
      hosts: [this.nativeHost],
      concurrency: 1,
      rangeStart: 0,
      rangeBytes: bytes,
      timeoutMs: this.config.coarseTimeoutMs,
      keepBack,
    });
    const r = results[0] || null;
    if (!r) return { stop: outcome.stopReason };
    if (NATIVE_FATAL[r.kind]) {
      this.nativeInvalid = true;
      return { fatal: 'native-invalid', result: r };
    }
    if (r.kind === 'short-object' && r.objectLength) {
      this.objectLength = r.objectLength;
      // The object is shorter than the coarse range: the whole round uses
      // [0, length-1], so the native response is a valid sample for it.
      r.ok = true;
      r.kind = 'ok';
      r.rangeBytes = r.objectLength;
      r.mbps = (r.bytes * 8) / (r.elapsedMs / 1000) / 1e6;
      const m = this.measurements[r.host];
      m.successes++;
      m.coarse = { mbps: r.mbps, elapsedMs: r.elapsedMs, bytes: r.bytes, order: r.order };
      this.coarseValid[r.host] = true;
    }
    if (this.objectLength !== null && this.objectLength < MIN_OBJECT_BYTES) return { fatal: 'object-too-small', result: r };
    return { result: r };
  }

  async coarse(hosts, concurrency, k, keepBack) {
    const cfg = this.config;
    const cutoff = new CutoffTracker({
      initialMs: cfg.coarseTimeoutMs,
      minMs: cfg.coarseMinTimeoutMs,
      maxMs: cfg.coarseTimeoutMs,
      alpha: cfg.cutoffAlpha,
      k,
      looseEvery: cfg.looseProbeEvery,
    });
    const stageResult = await this.stage({
      name: 'coarse',
      hosts,
      concurrency,
      rangeStart: 0,
      rangeBytes: cfg.coarseKiB * KiB,
      cutoff,
      keepBack,
      onResult: () => this.shouldAbort(),
    });
    return stageResult;
  }

  // Conservative rescue round when almost nothing completed (design §7.4):
  // native first, a few timed-out hosts, one wider timeout.
  async rescueIfNeeded(coarseResults, keepBack) {
    const started = coarseResults.length;
    const valid = coarseResults.filter((r) => r.ok).length;
    const lowSuccess = valid === 0 || (started >= 5 && valid / started < 0.2);
    if (!lowSuccess) return [];
    const timedOut = coarseResults.filter((r) => r.kind === 'timeout').map((r) => r.host);
    if (!timedOut.length) return [];
    timedOut.sort((a, b) => (a === this.nativeHost ? -1 : b === this.nativeHost ? 1 : 0));
    const { results } = await this.stage({
      name: 'rescue',
      hosts: timedOut.slice(0, 4),
      concurrency: 2,
      rangeStart: 0,
      rangeBytes: this.config.coarseKiB * KiB,
      timeoutMs: this.config.rescueTimeoutMs,
      keepBack,
    });
    return results;
  }

  async refine(hosts, k, keepBack) {
    const cfg = this.config;
    const cutoff = new CutoffTracker({
      initialMs: cfg.refineTimeoutMs,
      minMs: cfg.refineMinTimeoutMs,
      maxMs: cfg.refineTimeoutMs,
      alpha: cfg.cutoffAlpha,
      k,
      looseEvery: 0,
    });
    return this.stage({
      name: 'refine',
      hosts,
      concurrency: Math.min(cfg.refineConcurrency, this.cellular ? cfg.cellularConcurrency : 20),
      rangeStart: 0,
      rangeBytes: cfg.refineKiB * KiB,
      cutoff,
      keepBack,
      onResult: () => this.shouldAbort(),
    });
  }

  // Confirm reads a comparable range right after the refine range when the
  // object is long enough, so it is not served from bytes just fetched.
  confirmStart(confirmBytes) {
    const offset = this.config.refineKiB * KiB;
    if (this.objectLength !== null && this.objectLength >= offset + confirmBytes) return offset;
    return 0;
  }

  async confirm(hosts, confirmBytes, onConfirmed) {
    return this.stage({
      name: 'confirm',
      hosts,
      concurrency: this.config.confirmConcurrency,
      rangeStart: this.confirmStart(confirmBytes),
      rangeBytes: confirmBytes,
      timeoutMs: this.config.confirmTimeoutMs,
      keepBack: 0,
      onResult: (r) => (r.ok && onConfirmed ? onConfirmed(r) : null) || this.shouldAbort(),
    });
  }

  scoreOf(host) {
    const m = this.measurements[host];
    if (!m || !m.refine || !m.confirm || m.confirmFailed || m.lastKind !== 'ok') return null;
    return Math.min(m.refine.mbps, m.confirm.mbps);
  }

  validCoarse(hosts) {
    const out = [];
    hosts.forEach((h) => {
      const m = this.measurements[h];
      if (m && m.coarse) out.push({ host: h, elapsedMs: m.coarse.elapsedMs, mbps: m.coarse.mbps, order: m.coarse.order });
    });
    return out.sort(byElapsed);
  }

  validRefine(hosts) {
    const out = [];
    hosts.forEach((h) => {
      const m = this.measurements[h];
      if (m && m.refine) out.push({ host: h, mbps: m.refine.mbps, order: m.refine.order });
    });
    return out.sort(byMbps);
  }

  // Keep the native CDN unless the winner is clearly better than native's own
  // confirmed score (same hysteresis ratio as switching). An unconfirmed or
  // failed native sample never competes.
  preferNative(winner) {
    if (!winner || winner.host === this.nativeHost) return winner;
    const nativeScore = this.scoreOf(this.nativeHost);
    if (nativeScore !== null && winner.score < this.config.improvementRatio * nativeScore) {
      return { host: this.nativeHost, score: nativeScore, reason: 'native-competitive' };
    }
    return winner;
  }

  // Final winner plus backups; a winner displaced by native stays a backup.
  settleWinner(best, backups) {
    const chosen = this.preferNative(best);
    if (chosen && best && chosen.host !== best.host) backups.unshift({ host: best.host, mbps: best.score, confirmed: true });
    return chosen;
  }

  // Quick mode confirms only the winner. When native's refine sample is close
  // enough that it could still win, native gets the same confirm probe so the
  // comparison uses confirmed scores on both sides.
  async confirmNativeIfClose(winner, confirmBytes) {
    if (!winner || winner.host === this.nativeHost || this.scoreOf(this.nativeHost) !== null) return;
    const native = this.measurements[this.nativeHost];
    if (!native || !native.refine || native.confirmFailed) return;
    if (native.refine.mbps * this.config.improvementRatio <= winner.score) return;
    if (this.shouldAbort()) return;
    await this.confirm([this.nativeHost], confirmBytes);
  }

  // ---- quick mode -----------------------------------------------------------

  planQuick(coarseCount) {
    const cfg = this.config;
    const c = cfg.coarseKiB * KiB;
    const r = cfg.refineKiB * KiB;
    const f = cfg.quickConfirmKiB * KiB;
    const remaining = this.budget.remaining();
    if (remaining < c + r + f) return null;
    let refineTop = cfg.quickRefineTop;
    const minCoarse = Math.min(Math.max(coarseCount, 1), 8) * c;
    while (refineTop > 1 && remaining < minCoarse + refineTop * r + f) refineTop--;
    return { refineTop, coarseKeepBack: refineTop * r + f, refineKeepBack: f, confirmBytes: f };
  }

  async runQuick(shortlist, nextBatch) {
    const cfg = this.config;
    const plan0 = this.planQuick(shortlist.length);
    if (!plan0) return this.finish('insufficient-budget', null, [], 'budget', shortlist.length);
    const pre = await this.preflight(plan0.coarseKeepBack);
    if (pre.stop) return this.finish('aborted', null, [], pre.stop, shortlist.length);
    if (pre.fatal) return this.finish(pre.fatal, null, [], pre.fatal, shortlist.length);

    let best = null;
    let backups = [];
    let batch = shortlist.filter((h) => h !== this.nativeHost);
    const offered = {};
    offered[this.nativeHost] = true;
    batch.forEach((h) => { offered[h] = true; });
    let round = 0;
    let stopReason = null;
    let provisionalHost = null;
    const concurrency = this.cellular ? cfg.cellularConcurrency : cfg.quickConcurrency;

    for (;;) {
      const plan = this.planQuick(batch.length);
      if (!plan) {
        stopReason = 'budget';
        break;
      }
      const coarse = await this.coarse(batch, concurrency, plan.refineTop, plan.coarseKeepBack);
      let coarseResults = coarse.results.slice();
      if (round === 0 && pre.result) coarseResults.unshift(pre.result);
      coarseResults = coarseResults.concat(await this.rescueIfNeeded(coarseResults, plan.coarseKeepBack));
      const external = this.shouldAbort();
      if (external) {
        stopReason = external;
        break;
      }
      const roundHosts = (round === 0 ? [this.nativeHost] : []).concat(batch);
      const ranked = this.validCoarse(roundHosts);
      if (ranked.length) {
        const refineHosts = ranked.slice(0, plan.refineTop).map((x) => x.host);
        await this.refine(refineHosts, 1, plan.refineKeepBack);
        const refined = this.validRefine(refineHosts);
        let confirmed = null;
        // Quick mode confirms only the winner; a failed confirm falls through
        // to the next refine candidate while budget remains.
        for (let i = 0; i < refined.length && i < 2 && !confirmed; i++) {
          if (this.shouldAbort()) break;
          await this.confirm([refined[i].host], plan.confirmBytes);
          const score = this.scoreOf(refined[i].host);
          if (score !== null) confirmed = { host: refined[i].host, score };
        }
        await this.confirmNativeIfClose(confirmed, plan.confirmBytes);
        if (confirmed && (!best || confirmed.score > best.score)) {
          if (best) backups.unshift({ host: best.host, mbps: best.score, confirmed: true });
          best = confirmed;
        }
      }
      backups = backups.filter((b) => !best || b.host !== best.host);
      if (best && best.score >= this.targetMbps) {
        stopReason = 'target-reached';
        break;
      }
      const external2 = this.shouldAbort();
      if (external2) {
        stopReason = external2;
        break;
      }
      if (best && this.onProvisional && provisionalHost !== best.host) {
        provisionalHost = best.host;
        const provisionalBackups = this.confirmedBackups(best);
        this.onProvisional(this.settleWinner(best, provisionalBackups), provisionalBackups);
      }
      if (!cfg.expandOnMiss) {
        stopReason = 'expansion-disabled';
        break;
      }
      // Expansion only when the native sample and the network look healthy.
      if (this.nativeInvalid || !Object.keys(this.coarseValid).length) {
        stopReason = 'no-valid-sample';
        break;
      }
      batch = nextBatch ? nextBatch(20, (h) => !this.coarseStarted[h]) : [];
      if (!batch.length) {
        stopReason = 'candidates-exhausted';
        break;
      }
      batch.forEach((h) => { offered[h] = true; });
      round++;
    }
    const winner = best ? this.settleWinner(best, backups) : null;
    return this.finish(null, winner, backups, stopReason, Object.keys(offered).length);
  }

  // ---- full exploration -----------------------------------------------------

  async runFull(hostList) {
    const cfg = this.config;
    const seen = {};
    const orderedHosts = [this.nativeHost].concat(hostList).filter((h) => (seen[h] ? false : (seen[h] = true)));
    const c = cfg.coarseKiB * KiB;
    const r = cfg.refineKiB * KiB;
    const f = cfg.fullConfirmKiB * KiB;
    let coarseTop = cfg.fullCoarseTop;
    let refineTop = cfg.fullRefineTop;
    // Reserve refine and confirm budget before deciding how far coarse goes.
    while (refineTop > 1 && this.budget.remaining() < 10 * c + coarseTop * r + refineTop * f) refineTop--;
    while (coarseTop > refineTop && this.budget.remaining() < 10 * c + coarseTop * r + refineTop * f) coarseTop--;
    const keepCoarse = coarseTop * r + refineTop * f;
    if (this.budget.remaining() < c + r + f) return this.finish('insufficient-budget', null, [], 'budget', orderedHosts.length);

    const pre = await this.preflight(keepCoarse);
    if (pre.stop) return this.finish('aborted', null, [], pre.stop, orderedHosts.length);
    if (pre.fatal) return this.finish(pre.fatal, null, [], pre.fatal, orderedHosts.length);

    const hosts = orderedHosts.filter((h) => h !== this.nativeHost);
    const concurrency = this.cellular ? cfg.cellularConcurrency : cfg.discoveryConcurrency;
    const coarse = await this.coarse(hosts, concurrency, coarseTop, keepCoarse);
    const coarseResults = (pre.result ? [pre.result] : []).concat(coarse.results);
    await this.rescueIfNeeded(coarseResults, keepCoarse);
    let stopReason = coarse.outcome.stopReason === 'exhausted' ? null : coarse.outcome.stopReason;
    const external = this.shouldAbort();
    if (external) stopReason = external;

    let best = null;
    let backups = [];
    if (!external) {
      const ranked = this.validCoarse(orderedHosts).slice(0, coarseTop).map((x) => x.host);
      if (ranked.length) {
        const refineStage = await this.refine(ranked, refineTop, refineTop * f);
        if (refineStage.outcome.stopReason !== 'exhausted') stopReason = stopReason || refineStage.outcome.stopReason;
        const refined = this.validRefine(ranked).slice(0, refineTop).map((x) => x.host);
        const confirmStage = await this.confirm(refined, f, (res) => {
          const score = this.scoreOf(res.host);
          return cfg.fullEarlyStop && score !== null && score >= this.targetMbps ? 'target-reached' : null;
        });
        if (confirmStage.outcome.stopReason !== 'exhausted') stopReason = stopReason || confirmStage.outcome.stopReason;
        const confirmed = refined
          .map((h) => ({ host: h, score: this.scoreOf(h) }))
          .filter((x) => x.score !== null)
          .sort((a, b) => b.score - a.score);
        best = confirmed[0] || null;
        backups = confirmed.slice(1).map((x) => ({ host: x.host, mbps: x.score, confirmed: true }));
      }
    }
    const winner = best ? this.settleWinner(best, backups) : null;
    return this.finish(null, winner, backups, stopReason, orderedHosts.length);
  }

  confirmedBackups(winner) {
    return Object.keys(this.measurements)
      .map((host) => ({ host, mbps: this.scoreOf(host), confirmed: true }))
      .filter((b) => b.mbps !== null && (!winner || b.host !== winner.host))
      .sort((a, b) => b.mbps - a.mbps).slice(0, 4);
  }

  finish(status, winner, backups, stopReason, eligible) {
    if (!status) {
      if (winner) status = winner.score >= this.targetMbps ? 'target-reached' : 'selected';
      else status = Object.keys(this.coarseValid).length ? 'no-confirmed' : 'no-valid';
    }
    const started = Object.keys(this.coarseStarted).length;
    const coverage = {
      eligible: eligible === undefined ? started : eligible,
      started,
      valid: Object.keys(this.coarseValid).length,
    };
    const complete = this.mode === 'full' && !stopReason && coverage.started >= coverage.eligible;
    return {
      mode: this.mode,
      status,
      winner: winner || null,
      backups: this.confirmedBackups(winner),
      enoughFast: !!winner && winner.score >= this.targetMbps,
      targetMbps: this.targetMbps,
      stopReason: stopReason || 'completed',
      complete,
      partial: this.mode === 'full' && !complete,
      coverage,
      budget: this.budget.report(),
      objectLength: this.objectLength,
      measurements: this.measurements,
      failures: this.failures,
      stages: this.stages,
      peakInflight: this.pool.peak,
      durationMs: this.now() - this.startedAt,
    };
  }
}

module.exports = { DiscoverySession, MIN_OBJECT_BYTES };
