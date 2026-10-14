'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createDevice, SURGE_DIR } = require('../helpers/surge-vm');
const { mediaUrl, NATIVE } = require('../helpers/sim');

const ROOT = path.resolve(__dirname, '../..');
const WUHAN = 'cn-hbwh-fx-01-12.bilivideo.com';
const ARG = 'enabled=true&mode=manual&region=SG&targetMbps=80&historyPolicy=conservative&cellularDiscovery=false&routeRevision=default&probePolicy=&debug=false';

function freshUrl(rep) {
  return mediaUrl({ rep: rep || 30080, deadlineSec: Math.floor(Date.now() / 1000) + 3600 });
}

let requestSeq = 0;
async function request(device, url, headers) {
  const original = { url, method: 'GET', id: 'r' + ++requestSeq,
    headers: Object.assign({ Host: new URL(url).host, 'User-Agent': 'bili-ios', Range: 'bytes=0-999' }, headers || {}) };
  const result = await device.run('request-router.js', { $argument: ARG, $request: original });
  result.request = Object.assign({}, original, result.value);
  result.original = original;
  return result;
}

test('built bundles are current with src/', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'tools/build.mjs'), '--check'], { stdio: 'pipe' });
});

test('module file: scripts exist, patterns match only supported media, arguments declared', () => {
  const text = fs.readFileSync(path.join(SURGE_DIR, 'BilibiliCDNPicker.sgmodule'), 'utf8');
  const declared = /^#!arguments=(.*)$/m.exec(text)[1].split(',').map((x) => x.split(':')[0]);
  const used = Array.from(text.matchAll(/\{\{\{([A-Z_]+)\}\}\}/g), (m) => m[1]);
  assert.ok(used.length > 0);
  used.forEach((name) => assert.ok(declared.includes(name), name));
  const scripts = text.split('\n').filter((l) => /^BiliCDN-\w+ = type=/.test(l));
  assert.equal(scripts.length, 7);
  scripts.forEach((line) => {
    const scriptPath = /script-path=([^,\s]+)/.exec(line)[1];
    assert.ok(fs.existsSync(path.join(SURGE_DIR, scriptPath)), scriptPath);
    const pm = /pattern=([^,\s]+)/.exec(line);
    if (pm) {
      const re = new RegExp(pm[1]);
      assert.ok(re.test(freshUrl()));
      assert.ok(re.test(freshUrl().replace(NATIVE, 'upos-hz-mirrorakam.akamaized.net')));
      assert.ok(!re.test(freshUrl().replace(NATIVE, 'xy1x2x3x4xy.mcdn.bilivideo.cn')));
      assert.ok(!re.test(freshUrl().replace(NATIVE, 'upos-sz-mirroraliov.bilivideo.com:4483')));
      assert.ok(!re.test('https://api.bilibili.com/x/player/wbi/playurl?bvid=1'));
    }
  });
  const panels = text.split('\n').filter((l) => /script-name=/.test(l));
  assert.equal(panels.length, 2);
  assert.match(text, /hostname = %APPEND% upos-\*\.bilivideo\.com, cn-\*\.bilivideo\.com, ec-\*\.bilivideo\.com, upos-\*\.akamaized\.net/);
});

test('Surge flow with bundles: capture, panel tap, rewrite, 403 fallback', async () => {
  const device = createDevice({ cdn: { [NATIVE]: { delayMs: 120 }, [WUHAN]: { delayMs: 2 } } });
  // One signed resource per test: regenerating deadline on every call can
  // cross a wall-clock second and turn a cache-hit assertion into a miss.
  const url = freshUrl();

  // Unrelated traffic passes untouched.
  const other = await request(device, 'https://api.bilibili.com/x/web-interface/nav', {});
  assert.equal(JSON.stringify(other.value), '{}');

  // First media request: no decision yet, original request continues.
  const first = await request(device, url);
  assert.equal(JSON.stringify(first.value), '{}');
  assert.equal(first.doneCount(), 1);
  assert.ok(device.store.get('BiliCDNPicker.samples').includes(NATIVE));

  // Periodic panel refresh renders state without any download.
  const idle = await device.run('control-panel.js', { $argument: ARG + '&action=quick', $trigger: 'auto-interval', $input: { purpose: 'panel' } });
  assert.equal(idle.value.title, 'B站 CDN');
  assert.equal(device.httpCalls.length, 0);

  // Tapping the panel runs a quick selection in the panel's own session.
  const tapped = await device.run('control-panel.js', { $argument: ARG + '&action=quick', $trigger: 'button', $input: { purpose: 'panel' } });
  assert.ok(device.httpCalls.length > 0);
  assert.match(tapped.value.content, /cn-hbwh-fx-01-12/);
  device.httpCalls.forEach((c) => {
    assert.equal(c.options['binary-mode'], true);
    assert.equal(c.options['auto-redirect'], false);
    assert.ok(c.options.timeout > 0 && c.options.timeout <= 3);
  });

  // Later requests for the same resource go to the selected node.
  const rewritten = await request(device, url);
  assert.equal(rewritten.value.url, url.replace(NATIVE, WUHAN));
  assert.equal(rewritten.value.headers.Host, WUHAN);
  assert.equal(rewritten.value.headers.Range, 'bytes=0-999');

  // A probe re-entering the router is stripped and left alone.
  const probe = await request(device, url.replace(NATIVE, WUHAN), { 'X-BCP-Probe': 'x' });
  assert.equal(probe.value.headers['X-BCP-Probe'], undefined);
  assert.equal(probe.value.url, undefined);

  // The selected node answers 403: the observer records it, later requests fall back.
  const observed = await device.run('response-observer.js', {
    $argument: ARG,
    $request: rewritten.request,
    $response: { status: 403, headers: {} },
  });
  assert.equal(JSON.stringify(observed.value), '{}');
  const after = await request(device, url);
  assert.notEqual(after.value.headers && after.value.headers.Host, WUHAN);

  // Network change event and Shortcuts stop action.
  await device.run('network-event.js', { $event: { name: 'network-changed' } });
  assert.equal(JSON.parse(device.store.get('BiliCDNPicker.meta')).generation, 1);
  await device.run('discovery-runner.js', { $argument: ARG, $trigger: 'intent', $intent: { parameter: 'stop' } });
  assert.ok(JSON.parse(device.store.get('BiliCDNPicker.control')).stopRequestedAt > 0);

  // Logs never contain the signed query.
  assert.ok(device.logs.every((l) => !l.includes('upsig')));
  const stored = device.store.get('BiliCDNPicker.lastRun');
  assert.ok(!stored.includes('upsig'));
});

test('cron timer in manual mode exits without network access', async () => {
  const device = createDevice();
  await request(device, freshUrl());
  const r = await device.run('discovery-runner.js', { $argument: ARG, $cronexp: '*/15 * * * *' });
  assert.equal(r.doneCount(), 1);
  assert.equal(device.httpCalls.length, 0);
});

test('router errors still complete the request exactly once', async () => {
  const device = createDevice();
  const r = await device.run('request-router.js', {
    $argument: ARG,
    $request: { url: freshUrl(), method: 'GET', headers: { Host: NATIVE } },
    $persistentStore: { read: () => { throw new Error('store down'); }, write: () => { throw new Error('store down'); } },
  });
  // VM objects come from another realm: compare their JSON form.
  assert.equal(JSON.stringify(r.value), '{}');
  assert.equal(r.doneCount(), 1);
});


test('bundles retain request-time attribution across selection and ignore stripped probe failures', async () => {
  const device = createDevice({ cdn: { [NATIVE]: { delayMs: 120 }, [WUHAN]: { delayMs: 2 } } });
  const url = freshUrl();
  const pendingNative = await request(device, url);
  await device.run('control-panel.js', { $argument: ARG + '&action=quick', $trigger: 'button' });
  const pendingWinner = await request(device, url);
  assert.equal(pendingWinner.request.headers.Host, WUHAN);
  const probe = await request(device, url.replace(NATIVE, WUHAN), { 'X-BCP-Probe': 'probe' });
  await device.run('response-observer.js', { $argument: ARG, $request: probe.request, $response: { status: 403, headers: {} } });
  assert.equal(device.store.get('BiliCDNPicker.failures'), undefined);
  await device.run('response-observer.js', { $argument: ARG, $request: pendingNative.request, $response: { status: 403, headers: {} } });
  const root = JSON.parse(device.store.get('BiliCDNPicker.failures'));
  assert.equal(root.v, 2);
  const scope = Object.values(root.networks)[0];
  assert.equal(scope.hosts[WUHAN], undefined);
  assert.ok(Object.values(scope.resources)[0].nativeFailedAt);
  assert.equal((await request(device, url)).request.headers.Host, WUHAN);
});

test('Akamai HTTP playback can be measured manually without a panel and preserves scheme', async () => {
  const akamai = 'upos-hz-mirrorakam.akamaized.net';
  const device = createDevice({ cdn: { [akamai]: { delayMs: 120 }, [WUHAN]: { delayMs: 2 } } });
  const url = freshUrl().replace(NATIVE, akamai + ':80').replace('https:', 'http:');
  await request(device, url);
  const result = await device.run('control-panel.js', { $argument: ARG + '&action=quick', $trigger: 'editor' });
  assert.match(result.value.content, /已确认/);
  assert.ok(device.notifications.length > 0);
  assert.ok(device.httpCalls.every((c) => c.options.url.startsWith('http://')));
  const routed = await request(device, url);
  assert.equal(routed.value.url, url.replace(akamai + ':80', WUHAN));
  assert.equal(routed.value.headers.Host, WUHAN);
  const tls = await request(device, url.replace('http:', 'https:').replace(':80/', '/'));
  assert.equal(tls.value.url, undefined, 'HTTP result cannot be reused for HTTPS');
});

test('diagnostics from the script editor report runtime and samples without downloading', async () => {
  const device = createDevice();
  const result = await device.run('control-panel.js', { $argument: ARG + '&action=status', $trigger: 'editor' });
  assert.match(result.value.content, /Surge 5.x/);
  assert.match(result.value.content, /暂无媒体样本/);
  assert.equal(device.httpCalls.length, 0);
  assert.equal(device.notifications.length, 1);
  assert.ok(device.logs.some((s) => s.includes('暂无媒体样本')));
  await device.run('control-panel.js', { $argument: ARG + '&action=quick', $trigger: 'auto-interval' });
  assert.equal(device.httpCalls.length, 0);
  assert.equal(device.notifications.length, 1, 'periodic refresh does not send notifications');
});
