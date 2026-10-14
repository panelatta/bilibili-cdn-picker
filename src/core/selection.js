'use strict';

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

// Hot-path routing for one request. Returns {host, reason}; host === native
// means "pass through untouched".
function chooseRoute(ctx) {
  const now = ctx.now;
  const native = ctx.nativeHost;
  const config = ctx.config;
  const failures = ctx.failures || { resources: {}, hosts: {} };
  const rf = failures.resources ? failures.resources[ctx.resourceKey] : null;

  // Bounded rewrites per resource: no endless A -> B -> A loops.
  if (rf && rf.count >= config.maxSwitchesPerResource) return { host: native, reason: 'switch-limit' };

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
    if (host === native) return { host: native, reason: source + '-native' };
    if (!ctx.isValidHost(host)) continue;
    if (hostBlocked(host, rf, failures, now)) continue;
    return { host, reason: i === 0 ? source : source + '-fallback' };
  }
  return { host: native, reason: 'fallback-native' };
}

module.exports = { targetMbps, decideReplacement, chooseRoute };
