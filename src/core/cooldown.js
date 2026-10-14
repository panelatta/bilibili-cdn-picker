'use strict';

// Failure classification -> cooldown (design §10.1). Resource-scoped failures
// (403/404 for one signed URL) never poison the host globally; only repeated
// failures across distinct resources escalate to a host cooldown.

const PROBE_RULES = {
  forbidden: { scope: 'resource' },
  'not-found': { scope: 'resource' },
  'http-error': { scope: 'resource' },
  'server-error': { scope: 'host', seconds: 300 },
  'rate-limited': { scope: 'host', seconds: 600 },
  dns: { scope: 'host', seconds: 600 },
  tls: { scope: 'host', seconds: 600 },
  connect: { scope: 'host', seconds: 300 },
  redirect: { scope: 'host', seconds: 3600 },
  'range-ignored': { scope: 'host', seconds: 21600 },
  'range-mismatch': { scope: 'host', seconds: 1800 },
  'length-mismatch': { scope: 'host', seconds: 1800 },
  'bad-content-range': { scope: 'host', seconds: 1800 },
  'error-body': { scope: 'host', seconds: 1800 },
};

const STRIKE_WINDOW_MS = 30 * 60 * 1000;
const STRIKE_LIMIT = 3;
const STRIKE_COOLDOWN_MS = 30 * 60 * 1000;

function ruleFor(kind) {
  return PROBE_RULES[kind] || null;
}

// cooldowns: { 'h:<host>': {until, reason}, 'r:<resourceKey>|<host>': {...} }
function applyFailure(cooldowns, strikes, failure, ctx) {
  const rule = ruleFor(failure.kind);
  if (!rule) return;
  const now = ctx.now;
  if (rule.scope === 'resource') {
    cooldowns['r:' + ctx.resourceKey + '|' + failure.host] = { until: now + ctx.resourceTtlMs, reason: failure.kind };
    if (failure.kind === 'forbidden' || failure.kind === 'not-found') {
      const list = (strikes[failure.host] || []).filter((s) => now - s.at < STRIKE_WINDOW_MS && s.key !== ctx.resourceKey);
      list.push({ at: now, key: ctx.resourceKey });
      strikes[failure.host] = list.slice(-STRIKE_LIMIT);
      if (list.length >= STRIKE_LIMIT) {
        cooldowns['h:' + failure.host] = { until: now + STRIKE_COOLDOWN_MS, reason: 'repeated-' + failure.kind };
      }
    }
    return;
  }
  let seconds = rule.seconds;
  if (failure.kind === 'rate-limited' && failure.retryAfterSec > 0) seconds = Math.min(3600, Math.max(30, failure.retryAfterSec));
  const key = 'h:' + failure.host;
  const until = now + seconds * 1000;
  if (!cooldowns[key] || cooldowns[key].until < until) cooldowns[key] = { until, reason: failure.kind };
}

function coolingReason(cooldowns, host, resourceKey, now) {
  const h = cooldowns && cooldowns['h:' + host];
  if (h && h.until > now) return 'cooldown:' + h.reason;
  const r = resourceKey && cooldowns && cooldowns['r:' + resourceKey + '|' + host];
  if (r && r.until > now) return 'resource-cooldown:' + r.reason;
  return null;
}

function pruneCooldowns(cooldowns, now) {
  const out = {};
  Object.keys(cooldowns || {}).forEach((k) => {
    if (cooldowns[k] && cooldowns[k].until > now) out[k] = cooldowns[k];
  });
  return out;
}

module.exports = { applyFailure, coolingReason, pruneCooldowns, ruleFor, STRIKE_LIMIT, STRIKE_WINDOW_MS };
