'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRegistry, regionHosts } = require('../../src/core/candidates');
const { buildShortlist, nextExpansionBatch, fullExplorationOrder } = require('../../src/core/shortlist');
const data = require('../../data/cdn-candidates.json');

const SG = [
  'cn-hbwh-fx-01-12.bilivideo.com',
  'upos-sz-mirrorhwo1.bilivideo.com',
  'upos-sz-mirrorhw.bilivideo.com',
  'upos-sz-mirrorali.bilivideo.com',
  'cn-jssz-cm-02-08.bilivideo.com',
  'upos-sz-mirror08ct.bilivideo.com',
  'cn-hk-eq-01-14.bilivideo.com',
  'cn-jxnc-cm-01-04.bilivideo.com',
  'cn-bj-se-01-05.bilivideo.com',
  'upos-sz-mirror08h.bilivideo.com',
];

function hosts(n) {
  return Array.from({ length: n }, (_, i) => 'cn-test-' + i + '.bilivideo.com');
}

test('shipped registry: 299 validated hosts and the pinned SG table', () => {
  const reg = buildRegistry(data);
  assert.equal(reg.list.length, 299);
  assert.deepEqual(reg.warnings, []);
  assert.deepEqual(regionHosts(reg, 'SG'), SG);
  assert.deepEqual(regionHosts(reg, 'NONE'), []);
  assert.deepEqual(regionHosts(reg, 'ZZ'), []);
  assert.equal(new Set(reg.diversityOrder).size, 299);
  // Consecutive exploration picks come from different pools.
  const first = reg.diversityOrder.slice(0, 10).map((h) => reg.byHost[h].pool);
  assert.equal(new Set(first).size, 10);
});

test('registry rejects unsafe or foreign hostnames and duplicates', () => {
  const reg = buildRegistry({
    candidates: [
      { hostname: 'https://cn-a.bilivideo.com/x' },
      { hostname: 'cn-a.bilivideo.com:8080' },
      { hostname: 'u@cn-a.bilivideo.com' },
      { hostname: 'cn-a.bilivideo.com.attacker.example' },
      { hostname: 'CN-A.bilivideo.com' },
      { hostname: 'cn-a.bilivideo.com' },
      { hostname: 'cn-b.bilivideo.com', enabled: false },
    ],
    regions: { SG: { nodes: ['cn-a.bilivideo.com', 'evil.example', 'cn-a.bilivideo.com'] } },
  });
  assert.deepEqual(reg.list.map((x) => x.hostname), ['cn-a.bilivideo.com']);
  assert.equal(reg.warnings.length, 4);
  assert.deepEqual(reg.regions.SG, ['cn-a.bilivideo.com']);
  assert.equal(buildRegistry(null).list.length, 0);
});

test('SG cold start: native + 10 region nodes + exploration, Wuhan kept', () => {
  const reg = buildRegistry(data);
  const sl = buildShortlist({
    nativeHost: 'upos-sz-mirroraliov.bilivideo.com',
    regionHosts: regionHosts(reg, 'SG'),
    exploration: { order: reg.diversityOrder, cursor: 0, count: 4 },
    slots: { history: 5, region: 10 },
    limit: 20,
    rng: () => 0.9,
  });
  assert.equal(sl.hosts[0].host, 'upos-sz-mirroraliov.bilivideo.com');
  assert.equal(sl.hosts[0].source, 'native');
  assert.equal(sl.hosts.length, 15);
  assert.ok(sl.hosts.some((x) => x.host === 'cn-hbwh-fx-01-12.bilivideo.com' && x.source === 'region'));
  assert.equal(sl.hosts.filter((x) => x.source === 'explore').length, 4);
});

test('shortlist never exceeds the limit and keeps native under heavy duplication', () => {
  const native = 'upos-native.bilivideo.com';
  for (const n of [0, 1, 19, 20, 21, 300]) {
    const list = hosts(n);
    const sl = buildShortlist({
      nativeHost: native,
      priorHosts: list.slice(0, 2).concat([native]),
      preferredHosts: list.slice(0, 3),
      historyHosts: list.concat(list),
      regionHosts: list.slice(0, 10).concat([native]),
      exploration: { order: list, cursor: 5, count: 4 },
      slots: { history: 5, region: 10 },
      limit: 20,
      rng: () => 0.9,
    });
    assert.ok(sl.hosts.length <= 20, 'n=' + n);
    assert.equal(sl.hosts[0].host, native);
    assert.equal(sl.hosts.filter((x) => x.host === native).length, 1);
    assert.equal(new Set(sl.hosts.map((x) => x.host)).size, sl.hosts.length);
    assert.ok(sl.hosts.filter((x) => ['resource', 'preferred', 'history'].includes(x.source)).length <= 5);
  }
});

test('ineligible hosts are skipped without back-filling their slots', () => {
  const list = hosts(30);
  const sl = buildShortlist({
    nativeHost: 'upos-native.bilivideo.com',
    historyHosts: list.slice(0, 5),
    regionHosts: list.slice(0, 10),
    slots: { history: 5, region: 10 },
    limit: 20,
    isEligible: (h) => (h === list[1] || h === list[7] ? 'cooldown' : null),
  });
  assert.equal(sl.hosts.filter((x) => x.source === 'history').length, 4);
  assert.deepEqual(sl.hosts.filter((x) => x.source === 'region').map((x) => x.host), list.slice(5, 10).filter((h) => h !== list[7]));
  assert.equal(sl.skipped.length, 2);
});

test('expansion batches rotate through untested hosts', () => {
  const list = hosts(50);
  const tested = new Set(list.slice(0, 15));
  const a = nextExpansionBatch(list, 10, 20, (h) => !tested.has(h));
  assert.equal(a.hosts.length, 20);
  assert.equal(a.hosts[0], list[15]);
  a.hosts.forEach((h) => tested.add(h));
  const b = nextExpansionBatch(list, a.cursor, 20, (h) => !tested.has(h));
  assert.equal(b.hosts.length, 15);
  assert.equal(nextExpansionBatch([], 0, 5, () => true).hosts.length, 0);
});

test('full exploration order interleaves untested hosts with history', () => {
  const order = fullExplorationOrder('n.bilivideo.com', ['a', 'b', 'c', 'd', 'e', 'n.bilivideo.com'], ['x', 'y', 'a', 'z'], 3);
  assert.deepEqual(order, ['n.bilivideo.com', 'a', 'b', 'c', 'x', 'd', 'e', 'y', 'z']);
});
