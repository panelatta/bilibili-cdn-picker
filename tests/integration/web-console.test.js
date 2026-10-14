'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDevice } = require('../helpers/surge-vm');
const { mediaUrl, NATIVE } = require('../helpers/sim');

async function client(device) {
  async function call(path, body, extra) {
    const req = { url: 'https://bcp.test' + path, method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: 'https://bcp.test', 'Content-Type': 'application/json', 'X-BCP-Token': token },
      body: body === undefined ? undefined : JSON.stringify(body) };
    Object.assign(req, extra || {});
    const result = await device.run('web-control.js', { $request: req, $argument: 'mode=manual&region=SG' });
    const r = result.value.response;
    assert.equal(result.doneCount(), 1);
    return { code: r.status, headers: r.headers, raw: r.body, data: r.headers['Content-Type'].includes('json') ? JSON.parse(r.body) : null };
  }
  let token;
  const home = await call('/');
  assert.equal(home.code, 200);
  token = /name="bcp-token" content="([a-f0-9]{48})"/.exec(home.raw)[1];
  return { call, token, home };
}
async function capture(device, rep) {
  await device.run('request-router.js', { $request: { id: 'r-' + rep, method: 'GET',
    url: mediaUrl({ rep, deadlineSec: Math.floor(Date.now() / 1000) + 3600 }),
    headers: { 'User-Agent': 'bili-ios', Authorization: 'secret-private' } } });
}

test('local web assets bootstrap a stable token and status never probes or leaks media credentials', async () => {
  const d = createDevice();
  await capture(d, 30080);
  const c = await client(d);
  assert.match(c.home.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(c.home.headers['Cache-Control'], 'no-store');
  assert.ok((await c.call('/')).raw.includes(c.token), 'refresh does not invalidate another tab');
  for (const path of ['/app.js', '/app.css', '/icon.svg', '/manifest.webmanifest']) assert.equal((await c.call(path)).code, 200);
  const status = await c.call('/api/status');
  assert.equal(status.data.version, '0.4.1');
  assert.equal(status.data.current[0].confirmed, false);
  assert.equal(d.httpCalls.length, 0);
  assert.equal(d.apiCalls.length, 0);
  assert.doesNotMatch(status.raw, /upsig|upgcxcode|secret-private|Home|Authorization/);
  assert.equal((await c.call('/api/status', undefined, { headers: {} })).code, 401);
  assert.equal((await c.call('/api/status', undefined, { headers: { 'X-BCP-Token': c.token, Origin: 'https://evil.example' } })).code, 403);
  assert.equal((await c.call('/api/control', { action: 'pause' }, { method: 'OPTIONS' })).code, 403);
  assert.equal((await c.call('/api/control')).code, 404);
  assert.equal((await c.call('/api/control', { action: 'pause' }, { url: 'https://bcp.test.evil.example/api/control' })).code, 404);
});

test('web settings validate, persist, override module defaults and reject writes during a task', async () => {
  const d = createDevice(), c = await client(d);
  assert.equal((await c.call('/api/settings', { targetMbps: 0 })).code, 400);
  assert.equal((await c.call('/api/settings', { probePolicy: 'unapproved' })).code, 400);
  assert.equal((await c.call('/api/settings', { region: 'SG' }, { body: 'x'.repeat(4097) })).code, 400);
  assert.equal((await c.call('/api/settings', { targetMbps: 100, region: 'JP', enabled: false })).code, 200);
  const s = (await c.call('/api/status')).data.settings;
  assert.equal(s.targetMbps, 100); assert.equal(s.region, 'JP'); assert.equal(s.enabled, false);
  d.store.set('BiliCDNPicker.lease', JSON.stringify({ runId: 'other', expiresAt: Date.now() + 60000 }));
  assert.equal((await c.call('/api/settings', { enabled: true })).code, 409);
  assert.equal((await c.call('/api/control', { action: 'quick', resourceId: 'not-a-resource' })).code, 400);
});

test('web starts only the selected audio resource, keeps video unconfirmed and supports pause/resume', async () => {
  const d = createDevice(), c = await client(d);
  await capture(d, 30080); await capture(d, 30280);
  const before = (await c.call('/api/status')).data;
  const audio = before.current.find((r) => r.type === 'audio');
  const answer = await c.call('/api/control', { action: 'quick', resourceId: audio.resourceId });
  assert.equal(answer.code, 200);
  const s = answer.data.snapshot;
  assert.equal(s.lastRun.resources.length, 1);
  assert.equal(s.lastRun.resources[0].resourceKey, audio.resourceId);
  assert.equal(s.current.find((r) => r.type === 'audio').confirmed, true);
  assert.equal(s.current.find((r) => r.type === 'video').confirmed, false);
  assert.ok(s.lastRun.resources[0].results.some((r) => r.confirmed));
  assert.ok(d.httpCalls.every((r) => r.options.url.includes('-30280.m4s')));
  assert.doesNotMatch(answer.raw, /upsig|upgcxcode|secret-private/);
  const paused = await c.call('/api/control', { action: 'pause' });
  assert.equal(paused.data.snapshot.paused, true);
  assert.equal(paused.data.snapshot.current.find((r) => r.type === 'audio').confirmed, false);
  assert.equal((await c.call('/api/control', { action: 'resume' })).data.snapshot.paused, false);
});

test('open task POST allows parallel status/stop and rejects duplicate task launch', async () => {
  const d = createDevice({ cdn: { [NATIVE]: { delayMs: 200 } } }), c = await client(d);
  await capture(d, 30080);
  const id = (await c.call('/api/status')).data.current[0].resourceId;
  const running = c.call('/api/control', { action: 'full', resourceId: id });
  const live = await c.call('/api/status');
  assert.equal(live.data.job.active, true);
  const duplicate = await c.call('/api/control', { action: 'quick', resourceId: id });
  assert.equal(duplicate.code, 409);
  const stop = await c.call('/api/control', { action: 'stop' });
  assert.equal(stop.data.status, 'stop-requested');
  const dispatchedAtStop = d.httpCalls.length;
  const done = await running;
  assert.equal(done.data.snapshot.job.active, false);
  assert.equal(done.data.snapshot.lastRun.stopReason, 'stopped-by-user');
  assert.equal(d.httpCalls.length, dispatchedAtStop, 'stopping does not launch further downloads');
});

test('read-only panel refresh never starts downloads even on explicit button trigger', async () => {
  const d = createDevice(); await capture(d, 30080);
  const r = await d.run('control-panel.js', { $argument: 'action=status', $trigger: 'button', $input: { purpose: 'panel' } });
  assert.match(r.value.content, /https:\/\/bcp\.test/);
  assert.equal(d.httpCalls.length, 0);
});

test('status rejects old-network reports and ignores expired decisions', async () => {
  const d = createDevice(), c = await client(d); await capture(d, 30080);
  const id = (await c.call('/api/status')).data.current[0].resourceId;
  await c.call('/api/control', { action: 'quick', resourceId: id });
  const decisions = JSON.parse(d.store.get('BiliCDNPicker.decisions'));
  decisions.items[id].expiresAt = Date.now() - 1;
  d.store.set('BiliCDNPicker.decisions', JSON.stringify(decisions));
  assert.equal((await c.call('/api/status')).data.current[0].confirmed, false);
  d.network = { wifi: { ssid: 'Different-network' }, v4: { primaryInterface: 'en0' } };
  const other = (await c.call('/api/status')).data;
  assert.equal(other.lastRun, null); assert.equal(other.history.length, 0); assert.equal(other.current.length, 0);
});

test('reports survive resource changes, subsequent runs, reloads and network changes without leaking signed URLs', async () => {
  const d = createDevice(), c = await client(d); await capture(d, 30080);
  const firstId = (await c.call('/api/status')).data.current[0].resourceId;
  const first = await c.call('/api/control', { action: 'quick', resourceId: firstId });
  await capture(d, 30102);
  let s = (await c.call('/api/status')).data;
  assert.equal(s.current.find((r) => r.type === 'video').confirmed, false);
  assert.equal(s.recentRuns[0].resources[0].resourceKey, firstId);
  const nextId = s.current.find((r) => r.type === 'video').resourceId;
  await c.call('/api/control', { action: 'quick', resourceId: nextId });
  const reopened = await client(d);
  s = (await reopened.call('/api/status')).data;
  assert.equal(s.recentRuns.length, 2);
  assert.equal(s.recentRuns[1].runId, first.data.run.runId);
  assert.doesNotMatch(JSON.stringify(s.recentRuns), /upsig|upgcxcode|Authorization/);
  d.network = { v4: { primaryInterface: 'pdp_ip0' }, 'cellular-data': { carrier: 'Test' } };
  s = (await reopened.call('/api/status')).data;
  assert.equal(s.lastRun, null); assert.equal(s.recentRuns.length, 2);
});

test('manual web optimization really probes again and bypasses automatic dwell hysteresis', async () => {
  const d = createDevice({ cdn: { [NATIVE]: { delayMs: 2 } } }), c = await client(d); await capture(d, 30080);
  const id = (await c.call('/api/status')).data.current[0].resourceId;
  const first = await c.call('/api/control', { action: 'quick', resourceId: id });
  assert.equal(first.data.run.resources[0].winner, NATIVE);
  const count = d.httpCalls.length;
  const faster = 'cn-hbwh-fx-01-12.bilivideo.com';
  d.cdn[NATIVE] = { delayMs: 100 };
  d.cdn[faster] = { delayMs: 2 };
  const again = await c.call('/api/control', { action: 'quick', resourceId: id });
  assert.ok(d.httpCalls.length > count);
  assert.equal(again.data.run.resources[0].committed, true);
  assert.equal(again.data.run.resources[0].winner, faster);
  assert.equal(again.data.snapshot.current[0].selectedHost, faster);
});

test('cellular web full exploration ignores retired persisted restrictions and uses equal budgets', async () => {
  const d = createDevice({ network: { v4: { primaryInterface: 'pdp_ip0' }, 'cellular-data': { carrier: 'Test' } } });
  d.store.set('BiliCDNPicker.config', JSON.stringify({ cellularDiscovery: false, cellularTargetMiB: 4, cellularConcurrency: 1 }));
  const c = await client(d); await capture(d, 30080);
  const s = (await c.call('/api/status')).data;
  assert.equal(s.limits.quickTargetMiB, 12);
  assert.equal('cellularDiscovery' in s.settings, false);
  const result = await c.call('/api/control', { action: 'full', resourceId: s.current[0].resourceId });
  assert.equal(result.code, 200);
  assert.ok(result.data.run.resources.length > 0);
  assert.equal(result.data.run.resources[0].budget.limitBytes, 100 * 1024 * 1024);
});
