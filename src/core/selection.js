'use strict';

const { coolingReason } = require('./cooldown');

// Selection rules shared by the router (hot path) and the runner (commit).

// Design §7.5: 4 × a reliably known bitrate, otherwise the configured target.
function targetMbps(config, bitrateMbps) {
  return bitrateMbps > 0 ? config.bitrateMultiplier * bitrateMbps : config.targetMbps;
}

// Design §7.6: switch away from a usable decision only after the dwell time
// and with a clear improvement. Explicit failure bypasses the hysteresis.
function decideReplacement(current, candidate, now, config) {
  if (!current) return { replace: true, reason: 'new' };
  if (current.failed) return { replace: true, reason: 'current-failed' };
  if (current.expiresAt <= now) return { replace: true, reason: 'expired' };
  if (candidate.host === current.winner) return { replace: true, reason: 'refresh' };
  if (now - current.decidedAt < config.minDwellSeconds * 1000) return { replace: false, reason: 'dwell' };
  if (!(current.score > 0) || candidate.score >= config.improvementRatio * current.score) {
    return { replace: true, reason: 'improved' };
  }
  return { replace: false, reason: 'hysteresis' };
}

function hostBlocked(host, resourceFailure, failures, now) {
  if (resourceFailure && resourceFailure.hosts && resourceFailure.hosts[host]) return true;
  const hf = failures && failures.hosts && failures.hosts[host];
  return !!(hf && hf.until > now);
}

function unavailable(ctx, host) {
  const rf = ctx.failures && ctx.failures.resources && ctx.failures.resources[ctx.resourceKey];
  return !ctx.isValidHost(host) || hostBlocked(host, rf, ctx.failures, ctx.now) ||
    !!(host === ctx.nativeHost && rf && rf.nativeFailedAt) ||
    !!(ctx.decision && ctx.decision.networkKey === ctx.networkKey && ctx.decision.invalidHosts && ctx.decision.invalidHosts[host]) ||
    !!coolingReason(ctx.cooldowns, host, ctx.resourceKey, ctx.now);
}

function switchLimitReached(ctx) {
  const rf = ctx.failures && ctx.failures.resources && ctx.failures.resources[ctx.resourceKey];
  if (!rf) return false;
  const count = Array.isArray(rf.switches)
    ? rf.switches.filter((e) => e.decisionId === (ctx.decision && ctx.decision.runId || null)).length
    : rf.count || 0;
  return count >= ctx.config.maxSwitchesPerResource;
}

function usableDecisionHost(ctx) {
  const d = ctx.decision;
  if (!d || d.networkKey !== ctx.networkKey || !(d.expiresAt > ctx.now) || switchLimitReached(ctx)) return null;
  return [d.winner].concat(d.backups || []).find((host) => !unavailable(ctx, host)) || null;
}

// Hot-path routing for one request. Returns {host, reason}; host === native
// means "pass through untouched".
function chooseRoute(ctx) {
  const now = ctx.now;
  const native = ctx.nativeHost;
  const config = ctx.config;

  // Bounded rewrites per resource: no endless A -> B -> A loops.
  if (switchLimitReached(ctx)) return { host: native, reason: 'switch-limit' };

  let chain = null;
  let source = null;
  const d = ctx.decision;
  if (d && d.networkKey === ctx.networkKey && d.expiresAt > now) {
    chain = [d.winner].concat(d.backups || []);
    source = 'decision';
  } else if (config.historyPolicy === 'optimistic' && ctx.networkBest && ctx.networkBest.expiresAt > now) {
    chain = ctx.networkBest.hosts.slice();
    source = 'history';
  }
  if (!chain) return { host: native, reason: 'no-decision' };

  for (let i = 0; i < chain.length; i++) {
    const host = chain[i];
    if (unavailable(ctx, host)) continue;
    if (host === native) return { host: native, reason: source + '-native' };
    return { host, reason: i === 0 ? source : source + '-fallback' };
  }
  return { host: native, reason: 'fallback-native' };
}

module.exports = { targetMbps, decideReplacement, chooseRoute, usableDecisionHost, unavailable };
