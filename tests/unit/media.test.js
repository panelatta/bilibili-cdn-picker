'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUrl, replaceHost, getQueryParam } = require('../../src/media/url');
const { withHost, pickHeaders, getHeader, withoutHeaders, hasProbeMarker } = require('../../src/media/headers');
const { normalizeHostname, mediaHostFamily } = require('../../src/media/hosts');
const { matchMediaRequest } = require('../../src/media/adapters');
const { mediaUrl, NATIVE } = require('../helpers/sim');

test('replaceHost keeps path and query byte-for-byte', () => {
  const raw = 'https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/1/2/3/3-1-30080.m4s?a=1&a=2&b=%2F%2b&c=&d&e=x+y&e=%E4%B8%AD';
  const parsed = parseUrl(raw);
  const out = replaceHost(parsed, 'cn-hk-eq-01-14.bilivideo.com');
  assert.equal(out, raw.replace('upos-sz-mirroraliov.bilivideo.com', 'cn-hk-eq-01-14.bilivideo.com'));
  assert.equal(parseUrl(out).query, parsed.query);
  assert.equal(getQueryParam(parsed.query, 'a'), '1');
  assert.equal(getQueryParam(parsed.query, 'c'), '');
  assert.equal(getQueryParam(parsed.query, 'd'), '');
  assert.equal(getQueryParam(parsed.query, 'b'), '%2F%2b');
  assert.equal(getQueryParam(parsed.query, 'zz'), null);
});

test('replaceHost drops an explicit default port and nothing else', () => {
  const parsed = parseUrl('https://upos-sz-mirrorhw.bilivideo.com:443/upgcxcode/x/y.m4s?q=1');
  assert.equal(parsed.port, 443);
  assert.equal(replaceHost(parsed, 'a.bilivideo.com'), 'https://a.bilivideo.com/upgcxcode/x/y.m4s?q=1');
});

test('parseUrl rejects userinfo, control characters, IPv6 literals and bad ports', () => {
  assert.equal(parseUrl('https://user@upos-a.bilivideo.com/x'), null);
  assert.equal(parseUrl('https://upos-a.bilivideo.com/x\n'), null);
  assert.equal(parseUrl('https://upos-a.bilivideo.com/a b'), null);
  assert.equal(parseUrl('https://[::1]/x'), null);
  assert.equal(parseUrl('https://upos-a.bilivideo.com:99999/x'), null);
  assert.equal(parseUrl('upos-a.bilivideo.com/x'), null);
  assert.equal(parseUrl(42), null);
});

test('withHost replaces all Host case variants with one field', () => {
  const out = withHost({ host: 'old.example', HOST: 'old2', Range: 'bytes=0-99', 'User-Agent': 'ua' }, 'new.bilivideo.com');
  assert.deepEqual(Object.keys(out).filter((k) => k.toLowerCase() === 'host'), ['Host']);
  assert.equal(out.Host, 'new.bilivideo.com');
  // The real playback Range is never touched.
  assert.equal(out.Range, 'bytes=0-99');
  const h2 = withHost({ ':authority': 'old', host: 'old' }, 'n.bilivideo.com');
  assert.equal(h2[':authority'], 'n.bilivideo.com');
});

test('pickHeaders never copies Cookie, Authorization, Host or Range', () => {
  const picked = pickHeaders(
    { 'user-agent': 'ua', Cookie: 'SESSDATA=1', Authorization: 'x', Host: 'h', Range: 'bytes=0-1', Referer: 'https://www.bilibili.com/', 'X-Evil': 'a\r\nb' },
    ['User-Agent', 'Referer', 'Cookie', 'Authorization', 'Host', 'Range', 'X-Evil']
  );
  assert.deepEqual(picked, { 'user-agent': 'ua', Referer: 'https://www.bilibili.com/' });
  assert.equal(getHeader({ 'X-BCP-Probe': '1' }, 'x-bcp-probe'), '1');
  assert.ok(hasProbeMarker({ 'x-bcp-probe': 'run' }));
  assert.deepEqual(withoutHeaders({ 'x-bcp-probe': 'r', A: 'b' }, ['X-BCP-Probe']), { A: 'b' });
});

test('hostname validation and media host families use exact boundaries', () => {
  assert.equal(normalizeHostname('UPOS-SZ-MIRRORHW.bilivideo.com'), 'upos-sz-mirrorhw.bilivideo.com');
  for (const bad of ['https://a.bilivideo.com', 'a.bilivideo.com/x', 'u@a.bilivideo.com', 'a.bilivideo.com:443', 'a\u0000.bilivideo.com', '', '-a.bilivideo.com', 'localhost']) {
    assert.equal(normalizeHostname(bad), null, bad);
  }
  assert.equal(mediaHostFamily('cn-hbwh-fx-01-12.bilivideo.com'), 'upos');
  assert.equal(mediaHostFamily('upos-sz-mirror08c.bilivideo.com'), 'upos');
  assert.equal(mediaHostFamily('ec-jssz-ct-01-02.bilivideo.com'), 'upos');
  assert.equal(mediaHostFamily('upos-hz-mirrorakam.akamaized.net'), 'akamai');
  for (const bad of [
    'bilivideo.com.attacker.example',
    'upos-a.bilivideo.com.attacker.example',
    'evilbilivideo.com',
    'upos-a.evilbilivideo.com',
    'xy1x2x3x4xy.mcdn.bilivideo.cn',
    'cn-a.mcdn.bilivideo.com',
    'upos-mcdn-1.bilivideo.com',
    'www.bilivideo.com',
    'a248.e.akamai.net',
    'other.akamaized.net',
  ]) {
    assert.equal(mediaHostFamily(bad), null, bad);
  }
});

test('adapter matches only verified upgcxcode m4s requests', () => {
  const ok = matchMediaRequest(mediaUrl(), 'GET');
  assert.ok(ok);
  assert.equal(ok.info.mediaType, 'video');
  assert.equal(ok.info.representationId, 30080);
  assert.equal(ok.info.nativeHost, NATIVE);
  assert.ok(ok.info.deadlineMs > 0);
  assert.equal(matchMediaRequest(mediaUrl({ rep: 30280 }), 'GET').info.mediaType, 'audio');
  assert.equal(matchMediaRequest(mediaUrl(), 'POST'), null);
  assert.equal(matchMediaRequest(mediaUrl().replace('https://', 'http://'), 'GET'), null);
  assert.equal(matchMediaRequest(mediaUrl().replace('.com/', '.com:4483/'), 'GET'), null);
  assert.equal(matchMediaRequest(mediaUrl({ host: 'xy1x2.mcdn.bilivideo.cn' }), 'GET'), null);
  assert.equal(matchMediaRequest(mediaUrl({ host: 'upos-a.bilivideo.com.attacker.example' }), 'GET'), null);
  assert.equal(matchMediaRequest('https://upos-sz-mirrorhw.bilivideo.com/live-bvc/123/live.flv?x=1', 'GET'), null);
  assert.equal(matchMediaRequest('https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/../x.m4s?x=1', 'GET'), null);
  assert.equal(matchMediaRequest('https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/1/2/3.m4s', 'GET'), null);
});

test('resource key ignores the host but not the signed query', () => {
  const a = matchMediaRequest(mediaUrl(), 'GET').info;
  const b = matchMediaRequest(mediaUrl({ host: 'cn-hk-eq-01-14.bilivideo.com' }), 'GET').info;
  const c = matchMediaRequest(mediaUrl({ deadlineSec: 1760500000 }), 'GET').info;
  const d = matchMediaRequest(mediaUrl({ rep: 30064 }), 'GET').info;
  assert.equal(a.resourceKey, b.resourceKey);
  assert.notEqual(a.resourceKey, c.resourceKey);
  assert.notEqual(a.resourceKey, d.resourceKey);
  assert.equal(a.groupKey, d.groupKey);
});
