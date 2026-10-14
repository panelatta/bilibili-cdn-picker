'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveConfig, parseArgument, argumentValue } = require('../../src/core/config');
const { networkContext } = require('../../src/core/network');

test('defaults follow the design configuration contract', () => {
  const { config, warnings } = resolveConfig('', null);
  assert.deepEqual(warnings, []);
  assert.equal(config.enabled, true);
  assert.equal(config.mode, 'manual');
  assert.equal(config.shortlistLimit, 20);
  assert.equal(config.automaticFullDiscovery, false);
  assert.equal(config.cellularDiscovery, false);
  assert.equal(config.quickConcurrency, 4);
  assert.equal(config.cellularConcurrency, 2);
  assert.equal(config.discoveryConcurrency, 8);
  assert.equal(config.confirmConcurrency, 1);
  assert.equal(config.quickTargetMiB, 12);
  assert.equal(config.cellularTargetMiB, 4);
  assert.equal(config.discoveryTargetMiB, 100);
  assert.equal(config.resourceTtlSeconds, 600);
  assert.equal(config.fullScanTtlSeconds, 86400);
  assert.equal(config.targetMbps, 80);
  assert.equal(config.bitrateMultiplier, 4);
  assert.equal(config.minDwellSeconds, 60);
  assert.equal(config.improvementRatio, 1.25);
  assert.equal(config.debug, false);
});

test('module placeholders are ignored and argument values are validated', () => {
  const arg = 'enabled={{{ENABLED}}}&mode=ADAPTIVE&region=sg&targetMbps=120&discoveryConcurrency=99&quickTargetMiB=NaN&probePolicy=&action=full';
  const { config, warnings } = resolveConfig(arg, null);
  assert.equal(config.enabled, true);
  assert.equal(config.mode, 'adaptive');
  assert.equal(config.region, 'SG');
  assert.equal(config.targetMbps, 120);
  assert.equal(config.discoveryConcurrency, 8);
  assert.equal(config.quickTargetMiB, 12);
  assert.equal(config.probePolicy, '');
  assert.equal(warnings.length, 2);
  assert.equal(argumentValue(arg, 'action'), 'full');
  assert.equal(argumentValue('action={{{X}}}', 'action'), null);
  assert.deepEqual(Object.keys(parseArgument('unknown=1&debug=true')), ['debug']);
});

test('store overrides win over the argument; bad values fall back safely', () => {
  const { config, warnings, sources } = resolveConfig('debug=true&quickConcurrency=6', {
    quickConcurrency: -1,
    concurrency: 5,
    preferredHosts: ['cn-hk-eq-01-14.bilivideo.com'],
    probeHeaders: 'User-Agent,Referer',
    region: 'none',
  });
  assert.equal(config.quickConcurrency, 6);
  assert.equal(sources.quickConcurrency, 'argument');
  assert.equal(config.debug, true);
  assert.deepEqual(config.preferredHosts, ['cn-hk-eq-01-14.bilivideo.com']);
  assert.deepEqual(config.probeHeaders, ['User-Agent', 'Referer']);
  assert.equal(config.region, 'NONE');
  assert.equal(warnings.length, 2);
  assert.equal(resolveConfig('', { preferredHosts: 'https://evil/' }).config.preferredHosts.length, 0);
  assert.equal(resolveConfig('', 'not-an-object').config.enabled, true);
});

test('network context separates Wi-Fi, cellular and unknown networks', () => {
  const opts = { salt: 's1', generation: 3, routeRevision: 'direct-v1' };
  const home = networkContext({ wifi: { ssid: 'Home', bssid: 'aa' }, v4: { primaryInterface: 'en0' } }, opts);
  const roam = networkContext({ wifi: { ssid: 'Home', bssid: 'bb' }, v4: { primaryInterface: 'en0' } }, opts);
  const office = networkContext({ wifi: { ssid: 'Office' }, v4: { primaryInterface: 'en0' } }, opts);
  const cell = networkContext({ v4: { primaryInterface: 'pdp_ip0' }, 'cellular-data': { carrier: 'Singtel', radio: 'NR' } }, opts);
  assert.equal(home.type, 'wifi');
  assert.equal(home.key, roam.key, 'BSSID roaming keeps the profile');
  assert.notEqual(home.key, office.key);
  assert.equal(cell.type, 'cellular');
  assert.ok(cell.cellular);
  assert.ok(!home.label.includes('Home'), 'labels never contain the SSID');
  const newRoute = networkContext({ wifi: { ssid: 'Home' }, v4: { primaryInterface: 'en0' } }, Object.assign({}, opts, { routeRevision: 'proxy-v2' }));
  assert.notEqual(home.key, newRoute.key);
  const otherSalt = networkContext({ wifi: { ssid: 'Home' }, v4: { primaryInterface: 'en0' } }, Object.assign({}, opts, { salt: 's2' }));
  assert.notEqual(home.key, otherSalt.key);
  const unknownA = networkContext({ v4: { primaryInterface: 'en0' } }, opts);
  const unknownB = networkContext({ v4: { primaryInterface: 'en0' } }, Object.assign({}, opts, { generation: 4 }));
  assert.equal(unknownA.known, false);
  assert.notEqual(unknownA.key, unknownB.key, 'unknown networks are scoped to one generation');
  assert.equal(networkContext(undefined, opts).type, 'unknown');
});
