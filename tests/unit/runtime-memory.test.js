'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactResponse, httpGet } = require('../../src/adapters/surge/runtime');
const { evaluateProbe } = require('../../src/core/probe');
const { applyMobileLimits, CAPS } = require('../../src/core/mobile-limits');
const { resolveConfig } = require('../../src/core/config');

const response = { status: 206, headers: { 'Content-Range': 'bytes 0-65535/10000000', 'Content-Type': 'video/mp4' } };
const spec = { host: 'cn-a.bilivideo.com', stage: 'coarse', rangeStart: 0, rangeBytes: 65536, startedAt: 0 };

test('HTTP callback drops binary payload and response body before resolving the Promise', async () => {
  const previous = globalThis.$httpClient;
  const body = new Uint8Array(8 * 1024 * 1024);
  try {
    globalThis.$httpClient = { get: (_, cb) => cb(null, { ...response, body }, body) };
    const outcome = await httpGet({ url: 'https://cn-a.bilivideo.com/' });
    assert.equal(outcome.bodyBytes, body.byteLength);
    assert.equal(outcome.bodyKind, 'binary');
    assert.equal(outcome.data, undefined);
    assert.equal(outcome.response.body, undefined);
    assert.ok(JSON.stringify(outcome).length < 512, 'Promise retains only small scalar/header metadata');
  } finally {
    if (previous === undefined) delete globalThis.$httpClient;
    else globalThis.$httpClient = previous;
  }
});

test('compact response validation preserves byte counts and rejects text or error outcomes', () => {
  const ok = compactResponse(null, response, new Uint8Array(65536));
  assert.equal(evaluateProbe(spec, { ...ok, completedAt: 100 }).ok, true);
  const text = compactResponse(null, response, 'x'.repeat(65536));
  assert.equal(evaluateProbe(spec, { ...text, completedAt: 100 }).kind, 'error-body');
  const timeout = compactResponse('timed out', null, null);
  const result = evaluateProbe(spec, { ...timeout, completedAt: 100 });
  assert.equal(result.kind, 'timeout');
  assert.equal(result.bytes, null);
});

test('iOS changes only concurrent buffers and preserves the documented selection strategy', () => {
  const original = resolveConfig('', { quickConcurrency: 20, discoveryConcurrency: 20, fullConfirmKiB: 8192,
    maxResourcesPerRun: 4, runDeadlineSeconds: 300, discoveryTargetMiB: 512 }).config;
  const config = applyMobileLimits(original, { system: 'iOS' });
  for (const [key, cap] of Object.entries(CAPS)) assert.ok(config[key] <= cap, key);
  for (const key of Object.keys(original).filter((key) => !(key in CAPS))) {
    assert.deepEqual(config[key], original[key], key + ' must remain unchanged');
  }
  assert.equal(config.expandOnMiss, true);
  assert.equal(config.discoveryConcurrency, 2);
  assert.equal(config.fullConfirmKiB, 8192);
  assert.equal(original.fullConfirmKiB, 8192);
  assert.equal(applyMobileLimits(original, { system: 'macOS' }), original);
});


test('default iOS policy retains shortlists, expansion, Top 20/5, 1/4 MiB samples and budgets', () => {
  const config = applyMobileLimits(resolveConfig('', null).config, { system: 'iOS' });
  assert.equal(config.shortlistLimit, 20);
  assert.equal(config.expandOnMiss, true);
  assert.equal(config.coarseKiB, 128);
  assert.equal(config.refineKiB, 1024);
  assert.equal(config.quickConfirmKiB, 1024);
  assert.equal(config.fullConfirmKiB, 4096);
  assert.equal(config.fullCoarseTop, 20);
  assert.equal(config.fullRefineTop, 5);
  assert.equal(config.quickTargetMiB, 12);
  assert.equal(config.cellularTargetMiB, undefined);
  assert.equal(config.discoveryTargetMiB, 100);
  assert.equal(config.runDeadlineSeconds, 60);
  assert.equal(config.maxResourcesPerRun, 2);
  assert.equal(config.targetMbps, 80);
  assert.equal(config.fullEarlyStop, false);
});
