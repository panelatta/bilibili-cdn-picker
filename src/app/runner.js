'use strict';

const { DiscoverySession } = require('../core/discovery');
const { buildRegistry, regionHosts } = require('../core/candidates');
const { buildShortlist, nextExpansionBatch, fullExplorationOrder } = require('../core/shortlist');
const { applyFailure, coolingReason, pruneCooldowns } = require('../core/cooldown');
const { decideReplacement, targetMbps, usableDecisionHost, unavailable } = require('../core/selection');
const { createLogger } = require('../core/log');
const { randomId } = require('../core/hash');
const { MiB, round } = require('../core/format');
const { clearRequestContexts } = require('../core/request-context');
const { RequestPool } = require('../core/pool');
const { adapterById } = require('../media/adapters');
const S = require('../core/state');
const { loadConfig, ensureMeta, currentNetwork } = require('./context');
const { applyMobileLimits } = require('../core/mobile-limits');
const { resultRows } = require('../core/result-view');
const { saveRun, loadRuns } = require('../core/run-history');
const { ACTIONS, normalizeAction } = require('../core/actions');

// Discovery Runner (design §4.2). Runs as its own script session (panel tap,
// Shortcuts, cron timer or HTTP-API evaluation), never inside a request
// script. All results are committed only after re-checking lease, network
// generation and network key.

const MANUAL_TRIGGERS = { button: true, intent: true, editor: true };
const LEASE_GRACE_MS = 15000;

function writeControl(store, patch) {
  const control = store.readJson(S.KEYS.control, null);
  const next = Object.assign({}, S.isObject(control) ? control : {}, patch);
  store.writeJson(S.KEYS.control, next);
  return next;
}

// ctx: {action, trigger, argument, network(), store, now(), rng(), http(options),
//       setTimer, sink(line), registryData}
async function runAction(ctx) {
  const action = normalizeAction(ctx.action, 'auto');
  const store = ctx.store;
  const now = ctx.now();
  const loaded = loadConfig(store, ctx.argument);
  const config = applyMobileLimits(loaded.config, ctx.environment);
  switch (action) {
    case 'status':
      return { action, status: 'status' };
    case 'stop':
      writeControl(store, { stopRequestedAt: now });
      return { action, status: 'stop-requested' };
    case 'pause':
      writeControl(store, { paused: true });
      return { action, status: 'paused' };
    case 'resume':
      writeControl(store, { paused: false });
      return { action, status: 'resumed' };
    case 'clear-network':
      return clearNetwork(ctx, store, config, now);
    case 'clear-all':
      clearRequestContexts(store);
      ['samples', 'decisions', 'failures', 'state', 'lease', 'trigger', 'lastRun', 'runHistory', 'control', 'progress'].forEach((k) => store.remove(S.KEYS[k]));
      return { action, status: 'cleared' };
    default:
      return runDiscovery(ctx, action, config, loaded.warnings);
  }
}

function clearNetwork(ctx, store, config, now) {
  // A running task would write its in-memory copy back and undo the clear.
  const lease = store.readJson(S.KEYS.lease, null);
  if (S.isObject(lease) && lease.runId && lease.expiresAt > now) return { action: 'clear-network', status: 'busy' };
  const meta = ensureMeta(store, now, ctx.rng);
  const net = currentNetwork(ctx.network(), meta, config);
  const state = S.loadState(store);
  delete state.profiles[net.key];
  store.writeJson(S.KEYS.state, state);
  const decisions = S.loadDecisions(store);
  Object.keys(decisions.items).forEach((k) => {
    if (decisions.items[k].networkKey === net.key) delete decisions.items[k];
  });
  delete decisions.networks[net.key];
  store.writeJson(S.KEYS.decisions, decisions);
  store.writeJson(S.KEYS.runHistory, loadRuns(store).filter((r) => r.networkKey ? r.networkKey !== net.key : r.network !== net.label));
  const last = store.readJson(S.KEYS.lastRun, null);
  if (last && (last.networkKey ? last.networkKey === net.key : last.network === net.label)) store.remove(S.KEYS.lastRun);
  return { action: 'clear-network', status: 'cleared', network: net.label };
}

async function runDiscovery(ctx, requested, config, warnings) {
  const store = ctx.store;
  const startedAt = ctx.now();
  const rng = ctx.rng || Math.random;
  const summary = {
    action: requested,
    trigger: ctx.trigger || null,
    startedAt,
    finishedAt: null,
    status: null,
    stopReason: null,
    resources: [],
    warnings: (warnings || []).slice(0, 5),
  };
  function early(status, extra) {
    summary.status = status;
    summary.finishedAt = ctx.now();
    return Object.assign(summary, extra || {});
  }

  if (!config.enabled) return early('disabled');
  if (S.loadControl(store).paused) return early('paused');

  let action = requested;
  if (action === 'auto' && config.mode !== 'adaptive') {
    // Manual mode ignores cron timers and HTTP-API triggers.
    if (!MANUAL_TRIGGERS[ctx.trigger]) return early('manual-mode', { silent: true });
    action = 'quick';
  }
  const automatic = action === 'auto';
  const meta = ensureMeta(store, startedAt, rng);
  const net = currentNetwork(ctx.network(), meta, config);
  summary.network = net.label;
  summary.networkKey = net.key;
  summary.networkType = net.type;

  const activeLease = store.readJson(S.KEYS.lease, null);
  if (S.isObject(activeLease) && activeLease.runId && activeLease.expiresAt > startedAt) {
    return early('busy', { holder: activeLease.action, leaseExpiresAt: activeLease.expiresAt });
  }
  const registry = buildRegistry(ctx.registryData || (ctx.loadRegistry && ctx.loadRegistry()));
  const state = S.loadState(store);
  const logger = createLogger({ now: ctx.now, sink: ctx.sink, debug: config.debug, base: { gen: meta.generation } });
  if (state.candidateRevision !== registry.revision) {
    if (state.candidateRevision !== null) {
      // A new candidate list invalidates network rankings, not cooldowns.
      Object.keys(state.profiles).forEach((k) => {
        state.profiles[k].ranking = {};
        state.profiles[k].lastFullScanAt = null;
      });
      logger.event('cache_invalidated', { reason: 'candidate-revision' });
    }
    state.candidateRevision = registry.revision;
  }
  const samples = S.loadSamples(store);
  const decisions = S.loadDecisions(store);
  const failures = S.loadFailures(store, net.key);
  const profile = state.profiles[net.key] || S.emptyProfile(net, startedAt);
  profile.label = net.label;

  // Automatic full exploration backs off after any attempt, including partial
  // ones that never set lastFullScanAt.
  const fullDue = automatic && config.automaticFullDiscovery &&
    (!profile.lastFullScanAt || startedAt - profile.lastFullScanAt > config.fullScanTtlSeconds * 1000) &&
    (!profile.lastFullAttemptAt || startedAt - profile.lastFullAttemptAt > config.fullRetrySeconds * 1000);
  const mode = action === 'full' || fullDue ? 'full' : 'quick';
  const picked = pickTargets({ samples, decisions, failures, state, net, now: startedAt, config, action, mode, registry, resourceKey: ctx.resourceKey, manualReselect: ctx.manualReselect });
  if (!picked.targets.length) return early(picked.reason, { network: net.label });

  const runId = randomId(10, rng) + '-' + startedAt;
  const deadlineAt = startedAt + config.runDeadlineSeconds * 1000;
  const lease = acquireLease(store, runId, startedAt, deadlineAt + LEASE_GRACE_MS, action);
  if (lease.unwritable) return early('store-unavailable', { storeProblems: store.problems.slice(0, 5) });
  if (!lease.ok) return early('busy', { holder: lease.holder ? lease.holder.action : null });
  summary.runId = runId;
  summary.mode = mode;

  const pool = new RequestPool(20);
  const abortCheck = makeAbortCheck(ctx, store, config, meta, net, startedAt, runId);
  const run = { ctx, store, config, net, meta, registry, state, profile, runId, deadlineAt, pool, logger, abortCheck, rng };
  run.progress = { runId, action, networkKey: net.key, startedAt, deadlineAt, phase: 'starting', started: 0, completed: 0, active: true };
  store.writeJson(S.KEYS.progress, Object.assign({}, run.progress, { updatedAt: startedAt }));
  try {
    for (let i = 0; i < picked.targets.length; i++) {
      const reason = abortCheck() || (ctx.now() + 3000 > deadlineAt ? 'deadline' : null);
      if (reason) {
        summary.stopReason = reason;
        break;
      }
      summary.resources.push(await runForResource(run, picked.targets[i], mode));
    }
  } catch (error) {
    summary.status = 'failed';
    summary.stopReason = 'internal-error';
  } finally {
    const owner = store.readJson(S.KEYS.lease, null);
    if (owner && owner.runId === runId) {
      store.writeJson(S.KEYS.progress, Object.assign({}, run.progress, { active: false, updatedAt: ctx.now() }));
    }
    releaseLease(store, runId);
  }

  const first = summary.resources[0];
  summary.status = summary.status || (first ? first.status : 'aborted');
  summary.stopReason = summary.stopReason || (first ? first.stopReason : null);
  summary.finishedAt = ctx.now();
  summary.events = logger.events;
  summary.eventCounts = logger.counts;
  summary.storeProblems = store.problems.slice(0, 5);
  logger.event('run_finished', { status: summary.status, reason: summary.stopReason });
  saveRun(store, summary);
  return summary;
}

const MEDIA_ORDER = { video: 0, unknown: 1, audio: 2 };

function pickTargets(p) {
  const { samples, decisions, failures, state, net, now, config, action, mode } = p;
  const all = Object.keys(samples.items).map((k) => samples.items[k]).filter((s) => !p.resourceKey || s.key === p.resourceKey);
  if (!all.length) return { targets: [], reason: 'no-sample' };
  const fresh = all.filter((s) => s.networkKey === net.key && s.expiresAt > now && adapterById(s.adapter));
  if (!fresh.length) return { targets: [], reason: 'no-fresh-sample' };
  const usable = fresh.filter((s) => {
    const rf = failures.resources[s.key];
    return p.manualReselect || !(rf && rf.nativeFailedAt);
  });
  if (!usable.length) return { targets: [], reason: 'sample-invalid' };
  usable.sort((a, b) => (MEDIA_ORDER[a.mediaType] || 0) - (MEDIA_ORDER[b.mediaType] || 0) || b.capturedAt - a.capturedAt);
  if (mode === 'full') return { targets: [usable[0]], reason: null };

  const hasValid = (s) => {
    const d = decisions.items[s.key];
    const adapter = adapterById(s.adapter);
    const profile = state.profiles[net.key];
    return !!usableDecisionHost({
      decision: d, nativeHost: s.nativeHost, resourceKey: s.key, networkKey: net.key, now, config, failures,
      cooldowns: profile && profile.cooldowns,
      isValidHost: (h) => adapter.isCompatibleHost(h) && (h === s.nativeHost || !(p.registry && p.registry.disabled[h])),
    });
  };
  let candidates = action === 'quick-force' ? usable : usable.filter((s) => !hasValid(s));
  if (action === 'auto') {
    candidates = candidates.filter((s) => {
      const a = state.attempts[net.key + '|' + s.key];
      return !(a && now - a.at < config.retryAfterFailureSeconds * 1000);
    });
  }
  if (!candidates.length) return { targets: [], reason: action === 'auto' ? 'nothing-pending' : 'already-decided' };
  const first = candidates[0];
  const rest = candidates
    .slice(1)
    .filter((s) => s.mediaType !== first.mediaType || s.mediaType === 'unknown')
    .sort((a, b) => (a.groupKey === first.groupKey ? 0 : 1) - (b.groupKey === first.groupKey ? 0 : 1) || b.capturedAt - a.capturedAt);
  return { targets: [first].concat(rest).slice(0, config.maxResourcesPerRun), reason: null };
}

function acquireLease(store, runId, now, expiresAt, action) {
  const current = store.readJson(S.KEYS.lease, null);
  if (S.isObject(current) && current.runId && current.expiresAt > now) return { ok: false, holder: current };
  if (!store.writeJson(S.KEYS.lease, { runId, action, startedAt: now, expiresAt })) return { ok: false, unwritable: true };
  // Best effort: a concurrent writer may still win; commits re-check identity.
  const check = store.readJson(S.KEYS.lease, null);
  return { ok: S.isObject(check) && check.runId === runId };
}

function releaseLease(store, runId) {
  const current = store.readJson(S.KEYS.lease, null);
  if (S.isObject(current) && current.runId === runId) store.writeJson(S.KEYS.lease, null);
}

function makeAbortCheck(ctx, store, config, meta, net, startedAt, runId) {
  let lastCheck = -Infinity;
  let sticky = null;
  return function abortCheck() {
    if (sticky) return sticky;
    const now = ctx.now();
    // A web stop must take effect before the next dispatch, including during
    // a burst of fast failures. Only the more expensive identity check is throttled.
    const control = S.loadControl(store);
    if (control.stopRequestedAt && control.stopRequestedAt >= startedAt) return (sticky = 'stopped-by-user');
    if (control.paused) return (sticky = 'paused');
    if (now - lastCheck < 500) return null;
    lastCheck = now;
    const owner = store.readJson(S.KEYS.lease, null);
    if (!owner || owner.runId !== runId) return (sticky = 'lease-lost');
    const meta2 = S.loadMeta(store);
    if (meta2.generation !== meta.generation) sticky = 'network-changed';
    else if (currentNetwork(ctx.network(), meta2, config).key !== net.key) sticky = 'network-changed';
    return sticky;
  };
}

function verifyIdentity(run) {
  const lease = run.store.readJson(S.KEYS.lease, null);
  if (!S.isObject(lease) || lease.runId !== run.runId) return 'lease-lost';
  const meta2 = S.loadMeta(run.store);
  if (meta2.generation !== run.meta.generation) return 'network-changed';
  if (currentNetwork(run.ctx.network(), meta2, run.config).key !== run.net.key) return 'network-changed';
  return null;
}

function rankingList(profile, now, ttlMs) {
  return Object.keys(profile.ranking || {})
    .map((h) => profile.ranking[h])
    .filter((e) => e && e.confirmedMbps > 0 && now - e.confirmedAt < ttlMs)
    .sort((a, b) => b.confirmedMbps - a.confirmedMbps);
}

// Region table order is the cold-start prior; local fresh results re-rank it.
function reorderRegion(hosts, profile, now, ttlMs) {
  const scoreOf = (h) => {
    const e = profile.ranking && profile.ranking[h];
    if (!e) return null;
    if (e.confirmedMbps > 0 && now - e.confirmedAt < ttlMs) return e.confirmedMbps;
    if (e.refineMbps > 0 && now - e.refineAt < ttlMs) return e.refineMbps;
    return null;
  };
  return hosts
    .map((h, i) => ({ h, i, s: scoreOf(h) }))
    .sort((a, b) => (b.s !== null) - (a.s !== null) || (b.s || 0) - (a.s || 0) || a.i - b.i)
    .map((x) => x.h);
}

function rotate(list, start) {
  if (!list.length) return [];
  const s = ((start % list.length) + list.length) % list.length;
  return list.slice(s).concat(list.slice(0, s));
}

function reportProgress(run, name, fields, mediaType) {
  const p = run.progress;
  const changed = fields.stage && fields.stage !== p.phase;
  if (fields.stage) p.phase = fields.stage;
  p.mediaType = mediaType;
  if (name === 'probe_started') {
    p.started++;
    if (fields.host && !run.seenHosts[fields.host]) { run.seenHosts[fields.host] = true; p.nodesStarted++; }
  }
  if (name === 'probe_completed' || name === 'probe_rejected') {
    p.completed++;
    const m = run.liveMeasurements[fields.host] || (run.liveMeasurements[fields.host] = {});
    m.lastKind = name === 'probe_completed' ? 'ok' : fields.kind;
    m.lastStage = fields.stage;
    if (name === 'probe_completed') {
      const stage = ['refine', 'confirm'].includes(fields.stage) ? fields.stage : 'coarse';
      m[stage] = { mbps: fields.mbps, elapsedMs: fields.elapsedMs, bytes: fields.bytes };
    } else if (fields.stage === 'confirm') m.confirmFailed = true;
  }
  const now = run.ctx.now();
  if (!changed && p.updatedAt && now - p.updatedAt < 1000) return;
  const owner = run.store.readJson(S.KEYS.lease, null);
  if (!owner || owner.runId !== run.runId) return;
  p.updatedAt = now;
  p.results = resultRows(run.liveMeasurements, 20);
  run.store.writeJson(S.KEYS.progress, p);
}

async function runForResource(run, target, mode) {
  const { ctx, config, net, registry, profile, logger } = run;
  const now = ctx.now();
  run.liveMeasurements = {};
  run.seenHosts = {};
  Object.assign(run.progress, { resourceKey: target.key, representationId: target.representationId,
    started: 0, completed: 0, nodesStarted: 0, results: [] });
  const adapter = adapterById(target.adapter);
  const ttlMs = (net.known ? config.historyTtlSeconds : config.unknownNetworkTtlSeconds) * 1000;
  profile.cooldowns = pruneCooldowns(profile.cooldowns, now);
  const failures = S.loadFailures(run.store, net.key);
  const rf = failures.resources[target.key];
  const isEligible = (host) => {
    if (!adapter || !adapter.isCompatibleHost(host)) return 'incompatible';
    if (host !== target.nativeHost && registry.disabled[host]) return 'disabled';
    const c = coolingReason(profile.cooldowns, host, target.key, now);
    if (c) return c;
    const hf = failures.hosts[host];
    if (hf && hf.until > now) return 'observer-cooldown';
    if (rf && rf.hosts && rf.hosts[host]) return 'resource-failed';
    return null;
  };
  const ranking = rankingList(profile, now, ttlMs);
  const decisions = S.loadDecisions(run.store);
  const prior = decisions.items[target.key];
  const priorHosts = prior && prior.networkKey === net.key ? [prior.winner].concat(prior.backups || []) : [];
  const region = reorderRegion(regionHosts(registry, config.region), profile, now, ttlMs);
  const order = registry.diversityOrder;
  const cursor = typeof profile.exploreCursor === 'number' ? profile.exploreCursor : Math.floor(run.rng() * Math.max(1, order.length));
  const budgetMiB = mode === 'full' ? config.discoveryTargetMiB : config.quickTargetMiB;
  const target$ = targetMbps(config, null);

  const sample = { url: target.url, headers: target.headers, nativeHost: target.nativeHost };
  const session = new DiscoverySession({
    mode,
    config,
    sample,
    http: ctx.http,
    now: ctx.now,
    setTimer: ctx.setTimer,
    deadlineAt: run.deadlineAt,
    shouldAbort: run.abortCheck,
    log: (name, fields) => {
      logger.event(name, Object.assign({ media: target.mediaType }, fields));
      reportProgress(run, name, fields, target.mediaType);
    },
    runId: run.runId,
    targetMbps: target$,
    budgetBytes: budgetMiB * MiB,
    pool: run.pool,
    onProvisional: (winner, backups) => {
      // Playable but below target: use it now, keep searching (design §7.1.1).
      commitDecision(run, target, { winner, backups, enoughFast: false }, mode, true);
    },
  });

  let result;
  let shortlistInfo = null;
  if (mode === 'quick') {
    const coldStart = ranking.length === 0 && region.length === 0;
    const exploreCount = coldStart ? config.exploreMaxSlots : run.rng() < config.explorationRate ? config.exploreSlots : 0;
    const sl = buildShortlist({
      nativeHost: target.nativeHost,
      priorHosts,
      preferredHosts: config.preferredHosts,
      historyHosts: ranking.map((e) => e.host),
      regionHosts: region,
      exploration: { order, cursor, count: exploreCount },
      slots: { history: config.historySlots, region: config.regionSlots },
      limit: config.shortlistLimit,
      isEligible,
      rng: run.rng,
    });
    shortlistInfo = { size: sl.hosts.length, skipped: sl.skipped.length, sources: countSources(sl.hosts) };
    let expansionCursor = sl.exploreCursor;
    const inShortlist = {};
    sl.hosts.forEach((x) => { inShortlist[x.host] = true; });
    const nextBatch = (count, untested) => {
      const b = nextExpansionBatch(order, expansionCursor, count, (h) => !inShortlist[h] && untested(h) && !isEligible(h));
      expansionCursor = b.cursor;
      return b.hosts;
    };
    run.progress.candidates = sl.hosts.length;
    result = await session.runQuick(sl.hosts.map((x) => x.host), nextBatch);
    profile.exploreCursor = expansionCursor;
  } else {
    const recent = Object.keys(profile.ranking || {}).filter((h) => {
      const e = profile.ranking[h];
      return e && e.successes > 0 && now - (e.lastAt || 0) < ttlMs;
    });
    const primary = ranking.slice(0, 20).map((e) => e.host).concat(region).concat(recent);
    const ordered = fullExplorationOrder(target.nativeHost, primary, rotate(order, cursor), 3)
      .filter((h) => h === target.nativeHost || !isEligible(h));
    shortlistInfo = { size: ordered.length, skipped: order.length + 1 - ordered.length, sources: null };
    run.progress.candidates = ordered.length;
    result = await session.runFull(ordered);
    profile.exploreCursor = (cursor + 1) % Math.max(1, order.length);
  }

  const commit = commitResult(run, target, result, mode);
  return {
    key: target.key.slice(0, 10),
    resourceKey: target.key,
    results: resultRows(result.measurements, 30),
    mediaType: target.mediaType,
    representationId: target.representationId,
    nativeHost: target.nativeHost,
    mode,
    status: result.status,
    winner: result.winner ? result.winner.host : null,
    score: result.winner ? round(result.winner.score, 1) : null,
    winnerReason: result.winner ? result.winner.reason || null : null,
    enoughFast: result.enoughFast,
    targetMbps: result.targetMbps,
    backups: result.backups.length,
    stopReason: result.stopReason,
    complete: result.complete,
    partial: result.partial,
    coverage: result.coverage,
    budget: result.budget,
    peakInflight: result.peakInflight,
    durationMs: result.durationMs,
    shortlist: shortlistInfo,
    committed: commit.committed,
    commitReason: commit.reason,
  };
}

function countSources(hosts) {
  const out = {};
  hosts.forEach((x) => { out[x.source] = (out[x.source] || 0) + 1; });
  return out;
}

function updateProfile(run, target, result, mode) {
  const { profile, config, ctx } = run;
  const now = ctx.now();
  profile.ranking = profile.ranking || {};
  Object.keys(result.measurements).forEach((host) => {
    const m = result.measurements[host];
    const e = profile.ranking[host] || { host, attempts: 0, successes: 0, confirmedCount: 0 };
    e.attempts += m.attempts;
    e.successes += m.successes;
    e.lastKind = m.lastKind;
    e.lastAt = now;
    // Small-sample, refine and confirmed scores are separate fields.
    if (m.coarse) {
      e.coarseMbps = round(m.coarse.mbps, 2);
      e.coarseAt = now;
    }
    if (m.refine) {
      e.refineMbps = round(m.refine.mbps, 2);
      e.refineAt = now;
    }
    if (m.confirmFailed || m.lastKind !== 'ok') {
      delete e.confirmedMbps;
      delete e.confirmedAt;
    }
    if (m.refine && m.confirm && !m.confirmFailed && m.lastKind === 'ok') {
      e.confirmedMbps = round(Math.min(m.refine.mbps, m.confirm.mbps), 2);
      e.confirmedAt = now;
      e.confirmMode = mode;
      e.confirmedCount = (e.confirmedCount || 0) + 1;
    }
    profile.ranking[host] = e;
  });
  profile.cooldowns = profile.cooldowns || {};
  profile.strikes = profile.strikes || {};
  result.failures.forEach((f) => {
    applyFailure(profile.cooldowns, profile.strikes, f, {
      now,
      resourceKey: target.key,
      resourceTtlMs: config.resourceTtlSeconds * 1000,
    });
  });
  profile.ranking = S.pruneMap(profile.ranking, S.LIMITS.ranking, 'lastAt');
  profile.lastAttemptAt = now;
  profile.updatedAt = now;
  profile.explorationPending = !result.enoughFast;
  if (mode === 'full') {
    profile.lastFullAttemptAt = now;
    profile.lastFullCoverage = result.coverage;
    // Partial exploration never updates the full-scan timestamp.
    if (result.complete) profile.lastFullScanAt = now;
  }
}

function commitResult(run, target, result, mode) {
  const reject = verifyIdentity(run);
  if (reject) {
    run.logger.event('commit_rejected', { reason: reject, media: target.mediaType });
    return { committed: false, reason: reject };
  }
  updateProfile(run, target, result, mode);
  const state = run.state;
  state.profiles[run.net.key] = run.profile;
  state.profiles = S.pruneMap(state.profiles, S.LIMITS.profiles, 'updatedAt');
  state.attempts[run.net.key + '|' + target.key] = { at: run.ctx.now(), status: result.status };
  state.attempts = S.pruneMap(state.attempts, S.LIMITS.attempts, 'at');
  run.store.writeJson(S.KEYS.state, state);
  // A failed recheck must stop routing through the old choice even when no
  // replacement was found (timeouts have no response-observer callback).
  const decisions = S.loadDecisions(run.store);
  const prior = decisions.items[target.key];
  if (prior && prior.networkKey === run.net.key) {
    prior.invalidHosts = prior.invalidHosts || {};
    Object.keys(result.measurements).forEach((host) => {
      const m = result.measurements[host];
      if (m.confirmFailed || m.lastKind !== 'ok') prior.invalidHosts[host] = true;
    });
    run.store.writeJson(S.KEYS.decisions, decisions);
  }
  if (!result.winner) return { committed: false, reason: result.status };
  return commitDecision(run, target, result, mode, false);
}

function commitDecision(run, target, result, mode, provisional) {
  const { store, config, net, logger, ctx } = run;
  const reject = verifyIdentity(run);
  if (reject) {
    logger.event('commit_rejected', { reason: reject, media: target.mediaType });
    return { committed: false, reason: reject };
  }
  const now = ctx.now();
  let expiresAt = now + config.resourceTtlSeconds * 1000;
  if (target.deadlineMs) expiresAt = Math.min(expiresAt, target.deadlineMs - 30000);
  if (expiresAt <= now) return { committed: false, reason: 'signature-expiring' };

  const winner = result.winner;
  const decisions = S.loadDecisions(store);
  const failures = S.loadFailures(store, net.key);
  const current = decisions.items[target.key];
  let verdict;
  if (ctx.manualReselect) {
    verdict = { replace: true, reason: 'manual-retest' };
  } else if (current && current.runId === run.runId) {
    verdict = { replace: true, reason: 'same-run' };
  } else {
    let view = null;
    if (current && current.networkKey === net.key) {
      const adapter = adapterById(target.adapter);
      const health = {
        decision: current, nativeHost: target.nativeHost, resourceKey: target.key, networkKey: net.key, now, failures, config,
        cooldowns: run.profile.cooldowns,
        isValidHost: (h) => adapter.isCompatibleHost(h) && (h === target.nativeHost || !run.registry.disabled[h]),
      };
      view = Object.assign({}, current, {
        failed: unavailable(health, current.winner) || !usableDecisionHost(health),
      });
    }
    verdict = decideReplacement(view, { host: winner.host, score: winner.score }, now, config);
  }
  if (verdict.replace) {
    if (ctx.manualReselect) {
      const rf = failures.resources[target.key];
      if (rf) {
        // A successful explicit recheck supersedes this host's old failure,
        // but does not clear failures for untested alternatives.
        if (rf.hosts) delete rf.hosts[winner.host];
        if (winner.host === target.nativeHost) { delete rf.nativeFailedAt; delete rf.nativeStatus; }
        rf.count = 0;
        S.saveFailures(store, net.key, failures, now);
      }
    }
    decisions.items[target.key] = {
      key: target.key,
      mediaType: target.mediaType,
      representationId: target.representationId,
      networkKey: net.key,
      generation: run.meta.generation,
      nativeHost: target.nativeHost,
      winner: winner.host,
      backupVersion: 1,
      backups: (result.backups || []).filter((b) => b.confirmed && !run.registry.disabled[b.host])
        .map((b) => b.host).filter((h) => h !== winner.host).slice(0, 3),
      score: round(winner.score, 2),
      scoreMode: mode,
      enoughFast: !!result.enoughFast,
      provisional: !!provisional,
      reason: winner.reason || verdict.reason,
      decidedAt: current && current.winner === winner.host && current.decidedAt ? current.decidedAt : now,
      expiresAt,
      runId: run.runId,
    };
    logger.event('selection_confirmed', {
      media: target.mediaType, host: winner.host, mbps: winner.score, provisional: !!provisional, reason: winner.reason || verdict.reason,
    });
  } else {
    logger.event('selection_kept', { media: target.mediaType, host: current.winner, reason: verdict.reason });
  }
  // Compact network summary for the optional optimistic history policy.
  const best = rankingList(run.profile, now, (net.known ? config.historyTtlSeconds : config.unknownNetworkTtlSeconds) * 1000)
    .slice(0, 3)
    .map((e) => e.host);
  if (best.length) {
    decisions.networks[net.key] = {
      hosts: best,
      updatedAt: now,
      expiresAt: now + (net.known ? config.historyTtlSeconds : config.unknownNetworkTtlSeconds) * 1000,
    };
  }
  Object.keys(decisions.items).forEach((k) => {
    if (!(decisions.items[k].expiresAt > now)) delete decisions.items[k];
  });
  Object.keys(decisions.networks).forEach((k) => {
    if (!(decisions.networks[k].expiresAt > now)) delete decisions.networks[k];
  });
  decisions.items = S.pruneMap(decisions.items, S.LIMITS.decisions, 'decidedAt');
  decisions.networks = S.pruneMap(decisions.networks, S.LIMITS.networks, 'updatedAt');
  store.writeJson(S.KEYS.decisions, decisions);
  return { committed: verdict.replace, reason: verdict.reason };
}

module.exports = { runAction, normalizeAction, pickTargets, acquireLease, releaseLease, ACTIONS };
