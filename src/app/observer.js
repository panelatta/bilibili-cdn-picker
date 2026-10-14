'use strict';

const { matchMediaRequest } = require('../media/adapters');
const { getHeader, hasProbeMarker } = require('../media/headers');
const { requestContext } = require('../core/request-context');
const { parseRetryAfter } = require('../core/probe');
const { LIMITS, loadFailures, saveFailures, loadControl, pruneMap } = require('../core/state');
const { STRIKE_LIMIT, STRIKE_WINDOW_MS } = require('../core/cooldown');
const { loadConfig } = require('./context');

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
  const context = requestContext(store, request.id, info.resourceKey, now);
  // No request-time evidence means no attribution; never guess from a newer
  // decision or the current network. Stripped probes remain identifiable.
  if (!context || context.probe || !context.networkKey || !match.adapter.isCompatibleHost(context.host)) return null;

  let kind = null;
  if (status === 403 || status === 404 || status === 410) kind = 'forbidden';
  else if (status === 429) kind = 'rate-limited';
  else if (status >= 500 && status < 600) kind = 'server-error';
  else if (status === 200 && context.hasRange) kind = 'range-ignored';
  if (!kind) return null;
  // An expired signature fails on every host; it says nothing about the CDN.
  if (kind === 'forbidden' && info.deadlineMs && info.deadlineMs <= now) return null;

  const host = { host: context.host, isNative: context.host === context.nativeHost, inferred: false };
  const failures = loadFailures(store, context.networkKey);
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
    if (switched) {
      rf.count = (rf.count || 0) + 1;
      rf.switches = (rf.switches || []).concat({ host: host.host, decisionId: context.decisionId, at: now }).slice(-40);
    }
    hf.updatedAt = now;
    failures.hosts[host.host] = hf;
  }
  failures.resources[info.resourceKey] = rf;
  failures.resources = pruneMap(failures.resources, LIMITS.failures, 'updatedAt');
  failures.hosts = pruneMap(failures.hosts, LIMITS.failureHosts, 'updatedAt');
  saveFailures(store, context.networkKey, failures, now);
  if (ctx.log) ctx.log('fallback_selected ' + info.mediaType + ' status=' + status + ' host=' + host.host + (host.inferred ? ' (inferred)' : ''));
  return { host: host.host, status, kind, inferred: host.inferred };
}

module.exports = { handleResponse };
