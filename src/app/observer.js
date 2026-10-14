'use strict';

const { matchMediaRequest } = require('../media/adapters');
const { getHeader, hasProbeMarker } = require('../media/headers');
const { normalizeHostname } = require('../media/hosts');
const { chooseRoute } = require('../core/selection');
const { parseRetryAfter } = require('../core/probe');
const { KEYS, LIMITS, loadDecisions, loadFailures, loadSamples, loadControl, pruneMap } = require('../core/state');
const { STRIKE_LIMIT, STRIKE_WINDOW_MS } = require('../core/cooldown');
const { loadConfig, ensureMeta, currentNetwork } = require('./context');

// Response observation (design §10.2-§10.3). Runs without buffering the body
// and only records visible HTTP failures so that *later* requests fall back.
// The failed response itself is delivered untouched; the App retries.
// ctx: {request, response, argument, network, store, now, log}
function handleResponse(ctx) {
  const request = ctx.request;
  const response = ctx.response;
  if (!request || !response || typeof request.url !== 'string') return null;
  const status = Number(response.status);
  // Fast path: successful partial content needs no store access at all.
  if (status === 206 || status === 304 || status === 416 || !(status > 0)) return null;
  const match = matchMediaRequest(request.url, request.method);
  if (!match || hasProbeMarker(request.headers)) return null;

  const store = ctx.store;
  const config = loadConfig(store, ctx.argument).config;
  if (!config.enabled || loadControl(store).paused) return null;
  const now = ctx.now();
  const info = match.info;

  let kind = null;
  if (status === 403 || status === 404 || status === 410) kind = 'forbidden';
  else if (status === 429) kind = 'rate-limited';
  else if (status >= 500 && status < 600) kind = 'server-error';
  else if (status === 200 && getHeader(request.headers, 'Range')) kind = 'range-ignored';
  if (!kind) return null;
  // An expired signature fails on every host; it says nothing about the CDN.
  if (kind === 'forbidden' && info.deadlineMs && info.deadlineMs <= now) return null;

  const host = attributeHost(ctx, match, store, config, now);
  if (!host) return null;
  const failures = loadFailures(store);
  const rf = failures.resources[info.resourceKey] || { hosts: {}, count: 0 };
  rf.updatedAt = now;

  if (host.isNative) {
    // The native URL itself failed: the sample is unusable for probing.
    if (kind === 'forbidden') {
      rf.nativeFailedAt = now;
      rf.nativeStatus = status;
    } else {
      return null;
    }
  } else {
    rf.hosts = rf.hosts || {};
    const hf = failures.hosts[host.host] || { strikes: [] };
    // rf.count counts switches away from a host, not failed responses:
    // parallel Range requests failing together are one switch.
    let switched = false;
    if (kind === 'forbidden') {
      // 403/404 concern this signed resource only and stay for its lifetime.
      if (!rf.hosts[host.host]) {
        rf.hosts[host.host] = { status, at: now, inferred: host.inferred };
        switched = true;
      }
      hf.strikes = (hf.strikes || []).filter((s) => now - s.at < STRIKE_WINDOW_MS && s.key !== info.resourceKey);
      hf.strikes.push({ at: now, key: info.resourceKey, status });
      if (hf.strikes.length >= STRIKE_LIMIT) {
        hf.until = now + 30 * 60 * 1000;
        hf.reason = 'repeated-' + status;
      }
    } else {
      // Transient errors only cool the host down; it is retried afterwards.
      let seconds = kind === 'range-ignored' ? 21600 : kind === 'rate-limited' ? 600 : 300;
      const retryAfter = parseRetryAfter(getHeader(response.headers, 'Retry-After'), now);
      if (kind === 'rate-limited' && retryAfter > 0) seconds = Math.min(3600, Math.max(30, retryAfter));
      if (!(hf.until > now)) switched = true;
      if (!(hf.until > now + seconds * 1000)) {
        hf.until = now + seconds * 1000;
        hf.reason = kind;
      }
    }
    if (switched) rf.count = (rf.count || 0) + 1;
    hf.updatedAt = now;
    failures.hosts[host.host] = hf;
  }
  failures.resources[info.resourceKey] = rf;
  failures.resources = pruneMap(failures.resources, LIMITS.failures, 'updatedAt');
  failures.hosts = pruneMap(failures.hosts, LIMITS.failureHosts, 'updatedAt');
  store.writeJson(KEYS.failures, failures);
  if (ctx.log) ctx.log('fallback_selected ' + info.mediaType + ' status=' + status + ' host=' + host.host + (host.inferred ? ' (inferred)' : ''));
  return { host: host.host, status, kind, inferred: host.inferred };
}

// The response's $request should reflect the rewritten request. Playback can
// only reach a non-native host through our own rewrite, so a failure on a host
// outside this resource's current route (for example a runner probe whose
// marker was stripped by the request script) is ignored. If the request still
// shows the native host while the current route says "rewrite", the failure is
// attributed to that route target and flagged as inferred.
// Returns null (ignore) or {host, isNative, inferred}.
function attributeHost(ctx, match, store, config, now) {
  const key = match.info.resourceKey;
  const urlHost = match.parsed.host;
  const hostHeader = normalizeHostname(getHeader(ctx.request.headers, 'Host') || '');
  const meta = ensureMeta(store, now);
  const net = currentNetwork(ctx.network, meta, config);
  const decisions = loadDecisions(store);
  const d = decisions.items[key] || null;
  const best = decisions.networks[net.key] || null;
  const targets = [];
  if (d && d.networkKey === net.key && d.expiresAt > now) targets.push.apply(targets, [d.winner].concat(d.backups || []));
  if (config.historyPolicy === 'optimistic' && best && best.expiresAt > now) targets.push.apply(targets, best.hosts);
  const sample = loadSamples(store).items[key] || null;
  const recordedNative = (d && d.nativeHost) || (sample && sample.nativeHost) || null;
  let actual = urlHost;
  if ((!recordedNative || urlHost === recordedNative) && hostHeader && hostHeader !== urlHost && match.adapter.isCompatibleHost(hostHeader)) {
    actual = hostHeader;
  }
  const nativeHost = recordedNative || (targets.indexOf(actual) >= 0 ? null : actual);
  if (actual !== nativeHost) {
    return targets.indexOf(actual) >= 0 ? { host: actual, isNative: false, inferred: false } : null;
  }
  const route = chooseRoute({
    now,
    nativeHost: actual,
    resourceKey: key,
    networkKey: net.key,
    decision: d,
    networkBest: best,
    failures: loadFailures(store),
    config,
    isValidHost: (h) => match.adapter.isCompatibleHost(h),
  });
  if (route.host !== actual) return { host: route.host, isNative: false, inferred: true };
  return { host: actual, isNative: true, inferred: false };
}

module.exports = { handleResponse };
