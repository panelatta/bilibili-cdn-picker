'use strict';

const S = require('../core/state');
const { loadConfig, ensureMeta, currentNetwork } = require('./context');
const { chooseRoute, usableDecisionHost } = require('../core/selection');
const { adapterById } = require('../media/adapters');
const { applyMobileLimits } = require('../core/mobile-limits');
const { version } = require('../../package.json');

const SETTINGS = ['enabled', 'mode', 'region', 'targetMbps', 'historyPolicy', 'cellularDiscovery', 'debug'];
function pick(object, keys) {
  const out = {};
  keys.forEach((key) => { if (object && object[key] !== undefined) out[key] = object[key]; });
  return out;
}
function rows(items) {
  return (Array.isArray(items) ? items : []).slice(0, 30).map((r) =>
    pick(r, ['host', 'confirmed', 'status', 'stage', 'mbps', 'elapsedMs', 'bytes']));
}
function resourceResult(r) {
  return Object.assign(pick(r, ['resourceKey', 'mediaType', 'representationId', 'nativeHost', 'mode', 'status', 'winner',
    'score', 'winnerReason', 'enoughFast', 'targetMbps', 'backups', 'stopReason', 'complete', 'partial', 'durationMs', 'committed', 'commitReason']), {
    coverage: pick(r.coverage, ['eligible', 'started', 'valid']),
    budget: pick(r.budget, ['limitBytes', 'observedBytes', 'outstandingBytes', 'unobservableBytes', 'unobservableCount', 'overrunCount']),
    results: rows(r.results),
  });
}

function webStatus(ctx) {
  const now = ctx.now(), store = ctx.store;
  const loaded = loadConfig(store, ctx.argument);
  const config = loaded.config, effective = applyMobileLimits(config, ctx.environment);
  const meta = ensureMeta(store, now, ctx.rng), net = currentNetwork(ctx.network(), meta, config);
  const state = S.loadState(store), profile = state.profiles[net.key];
  const samples = S.loadSamples(store), decisions = S.loadDecisions(store), failures = S.loadFailures(store, net.key);
  const control = S.loadControl(store), latest = {};
  for (const s of Object.values(samples.items)) {
    if (s.networkKey !== net.key) continue;
    if (!latest[s.mediaType] || latest[s.mediaType].capturedAt < s.capturedAt) latest[s.mediaType] = s;
  }
  const current = ['video', 'audio', 'unknown'].filter((t) => latest[t]).map((type) => {
    const s = latest[type], d = decisions.items[s.key], adapter = adapterById(s.adapter);
    const context = { now, nativeHost: s.nativeHost, resourceKey: s.key, networkKey: net.key, decision: d,
      networkBest: decisions.networks[net.key], failures, config, cooldowns: profile && profile.cooldowns,
      isValidHost: (h) => !!adapter && adapter.isCompatibleHost(h) && (!ctx.isCandidateEnabled || h === s.nativeHost || ctx.isCandidateEnabled(h)) };
    const route = chooseRoute(context), usable = usableDecisionHost(context);
    const routing = !config.enabled || control.paused ? s.nativeHost : route.host;
    // A cached winner for another resource (or a blocked winner) cannot paint this resource green.
    const confirmed = !!usable && usable === routing && config.enabled && !control.paused;
    return { resourceId: s.key, type, representationId: s.representationId, nativeHost: s.nativeHost,
      sampleAt: s.capturedAt, fresh: s.expiresAt > now, sampleExpiresAt: s.expiresAt,
      selectedHost: routing, confirmed, changed: routing !== s.nativeHost,
      score: confirmed && d && d.winner === routing ? d.score : null,
      decisionExpiresAt: confirmed && d ? d.expiresAt : null,
      reason: !config.enabled || control.paused ? 'paused' : route.reason,
      enoughFast: confirmed && d && d.winner === routing ? !!d.enoughFast : false };
  });
  const lease = store.readJson(S.KEYS.lease, null), progress = store.readJson(S.KEYS.progress, null);
  const active = !!(lease && lease.runId && lease.expiresAt > now);
  const job = active ? Object.assign(pick(lease, ['runId', 'action', 'startedAt', 'expiresAt']),
    progress && progress.runId === lease.runId ? pick(progress, ['phase', 'mediaType', 'representationId', 'resourceKey',
      'started', 'completed', 'nodesStarted', 'candidates', 'updatedAt', 'deadlineAt']) : {},
    { active: true, results: progress && progress.runId === lease.runId ? rows(progress.results) : [] }) :
    { active: false, expired: !!(lease && lease.runId), results: [] };
  const rawRun = store.readJson(S.KEYS.lastRun, null);
  const lastRun = rawRun && (rawRun.networkKey ? rawRun.networkKey === net.key : rawRun.network === net.label) ? Object.assign(pick(rawRun,
    ['runId', 'mode', 'status', 'stopReason', 'startedAt', 'finishedAt']),
    { resources: (rawRun.resources || []).slice(0, 4).map(resourceResult) }) : null;
  const history = Object.values(profile && profile.ranking || {}).filter((r) => r.confirmedMbps > 0 && now - r.confirmedAt < config.historyTtlSeconds * 1000)
    .sort((a, b) => b.confirmedMbps - a.confirmedMbps).slice(0, 20)
    .map((r) => pick(r, ['host', 'confirmedMbps', 'confirmedAt', 'confirmMode', 'attempts', 'successes']));
  return { version, now, preview: !!ctx.preview, network: { label: net.label, type: net.type },
    environment: pick(ctx.environment, ['system', 'surge-version']),
    settings: pick(config, SETTINGS), paused: control.paused, current, job, lastRun, history,
    limits: pick(effective, ['quickConcurrency', 'discoveryConcurrency', 'refineConcurrency', 'confirmConcurrency',
      'quickTargetMiB', 'cellularTargetMiB', 'discoveryTargetMiB', 'coarseKiB', 'refineKiB', 'quickConfirmKiB', 'fullConfirmKiB', 'runDeadlineSeconds']),
    storageWarnings: store.problems.slice(0, 4).map((p) => p.problem) };
}
module.exports = { webStatus, SETTINGS };
