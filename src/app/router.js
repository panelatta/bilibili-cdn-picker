'use strict';

const { matchMediaRequest } = require('../media/adapters');
const { replaceHost } = require('../media/url');
const { withHost, withoutHeaders, hasProbeMarker, pickHeaders, PROBE_MARKER } = require('../media/headers');
const { chooseRoute } = require('../core/selection');
const { KEYS, LIMITS, loadSamples, loadDecisions, loadFailures, loadControl, pruneMap } = require('../core/state');
const { loadConfig, ensureMeta, currentNetwork } = require('./context');

// Request hot path (design §4.3). No probing and no waiting here: validate,
// read the cached decision, rewrite host + Host or pass through, update the
// throttled sample, and return the single $done payload.
// ctx: {request, argument, network, store, now, httpApi, log}
function handleRequest(ctx) {
  const request = ctx.request;
  if (!request || typeof request.url !== 'string') return {};
  const match = matchMediaRequest(request.url, request.method);
  if (!match) return {};

  // A probe from our own runner re-entered the HTTP engine: strip the marker
  // so it never leaves the device, and never rewrite or sample it.
  if (hasProbeMarker(request.headers)) {
    if (ctx.log) ctx.log('probe re-entered request script (' + match.parsed.host + ')');
    return { headers: withoutHeaders(request.headers, [PROBE_MARKER]) };
  }

  const store = ctx.store;
  const config = loadConfig(store, ctx.argument).config;
  if (!config.enabled || loadControl(store).paused) return {};

  const now = ctx.now();
  const meta = ensureMeta(store, now);
  const net = currentNetwork(ctx.network, meta, config);
  const info = match.info;
  const decisions = loadDecisions(store);
  const decision = decisions.items[info.resourceKey] || null;
  const route = chooseRoute({
    now,
    nativeHost: info.nativeHost,
    resourceKey: info.resourceKey,
    networkKey: net.key,
    decision,
    networkBest: decisions.networks[net.key] || null,
    failures: loadFailures(store),
    config,
    isValidHost: (h) => match.adapter.isCompatibleHost(h),
  });

  const hasDecision = !!(decision && decision.networkKey === net.key && decision.expiresAt > now);
  const captured = captureSample(store, match, request, net, config, now);
  if (captured && config.debug && ctx.log) ctx.log('sample_captured ' + info.mediaType + ' ' + info.nativeHost);
  if (config.mode === 'adaptive' && !hasDecision && captured && (!net.cellular || config.cellularDiscovery)) {
    maybeTrigger(ctx, store, config, now, info.resourceKey);
  }

  if (route.host === info.nativeHost) return {};
  if (config.debug && ctx.log) ctx.log('rewrite ' + info.mediaType + ' -> ' + route.host + ' (' + route.reason + ')');
  return { url: replaceHost(match.parsed, route.host), headers: withHost(request.headers, route.host) };
}

// Throttled: one write per resource every `sampleRefreshSeconds`. The sample
// keeps the original (native) URL; its TTL never exceeds the signature.
function captureSample(store, match, request, net, config, now) {
  const info = match.info;
  const samples = loadSamples(store);
  const existing = samples.items[info.resourceKey];
  if (existing && existing.networkKey === net.key && now - existing.capturedAt < config.sampleRefreshSeconds * 1000) {
    return false;
  }
  let expiresAt = now + config.sampleTtlSeconds * 1000;
  if (info.deadlineMs) expiresAt = Math.min(expiresAt, info.deadlineMs - 30000);
  if (expiresAt <= now) return false;
  samples.items[info.resourceKey] = {
    key: info.resourceKey,
    url: request.url,
    headers: pickHeaders(request.headers, config.probeHeaders),
    nativeHost: info.nativeHost,
    adapter: info.adapter,
    mediaType: info.mediaType,
    representationId: info.representationId,
    groupKey: info.groupKey,
    deadlineMs: info.deadlineMs,
    networkKey: net.key,
    capturedAt: now,
    firstSeenAt: existing && existing.firstSeenAt ? existing.firstSeenAt : now,
    expiresAt,
  };
  Object.keys(samples.items).forEach((k) => {
    if (!(samples.items[k].expiresAt > now)) delete samples.items[k];
  });
  samples.items = pruneMap(samples.items, LIMITS.samples, 'capturedAt');
  store.writeJson(KEYS.samples, samples);
  return true;
}

// Adaptive mode only: ask Surge to run the runner cron script in its own
// session. Whether that session outlives this request script is a runtime
// experiment (design §13.1); the trigger record lets the panel show it.
function maybeTrigger(ctx, store, config, now, resourceKey) {
  const last = store.readJson(KEYS.trigger, null);
  if (last && typeof last.lastAt === 'number' && now - last.lastAt < config.autoTriggerIntervalSeconds * 1000) return;
  store.writeJson(KEYS.trigger, { lastAt: now, resourceKey, count: ((last && last.count) || 0) + 1 });
  if (ctx.httpApi) ctx.httpApi('POST', '/v1/scripting/cron/evaluate', { script_name: config.runnerScriptName });
}

module.exports = { handleRequest, captureSample };
