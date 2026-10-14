'use strict';
// Execute the shipped browser controller against a minimal DOM and controllable
// HTTP transport. This reproduces Safari returning with an unresolved task POST.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { flush } = require('../helpers/sim');

function browser() {
  class Element {
    constructor() { this.children = []; this.hidden = false; this.textContent = ''; this.classList = { toggle() {} }; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute() {} removeAttribute() {} addEventListener() {} showModal() {} close() {}
  }
  const elements = {};
  for (const m of fs.readFileSync('src/web/index.html', 'utf8').matchAll(/id="([^"]+)"/g)) elements[m[1]] = new Element();
  elements.quick.firstElementChild = new Element();
  const events = {}, document = { hidden: false, getElementById: (id) => elements[id],
    querySelector: () => ({ content: 'local-token' }), querySelectorAll: () => [], createElement: () => new Element(),
    addEventListener: (event, cb) => { events[event] = cb; } };
  let now = 100000, status = { now, version: '0.4.1', network: { type: 'cellular', label: '蜂窝 #1234' },
    settings: { enabled: true, targetMbps: 80 }, paused: false, job: { active: false }, history: [], recentRuns: [],
    limits: { quickTargetMiB: 12, discoveryTargetMiB: 100, discoveryConcurrency: 2, confirmConcurrency: 1, runDeadlineSeconds: 60 },
    current: [{ resourceId: 'v-1111111111111111', type: 'video', representationId: 30102, fresh: true, confirmed: false,
      nativeHost: 'upos-origin.bilivideo.com', selectedHost: 'upos-origin.bilivideo.com', sampleAt: now }] };
  const posts = [];
  const fetch = async (path, init) => {
    if (path === '/api/status') return { ok: true, json: async () => JSON.parse(JSON.stringify(status)) };
    return new Promise((resolve) => posts.push({ body: JSON.parse(init.body), resolve: (data) => resolve({ ok: true, json: async () => data }) }));
  };
  class ClockDate extends Date { static now() { return now; } }
  vm.runInNewContext(fs.readFileSync('src/web/app.browser.js', 'utf8'), { document, fetch, Date: ClockDate, AbortController,
    setTimeout: () => 1, clearTimeout() {}, console });
  return { elements, posts, status, async resume(ms) { now += ms; status.now = now; document.hidden = false; events.visibilitychange(); await flush(); },
    snapshot: () => JSON.parse(JSON.stringify(status)) };
}

function report(id) {
  return { runId: id, network: '蜂窝 #1234', finishedAt: 100001, resources: [{ resourceKey: 'v-0000000000000000', mediaType: 'video',
    representationId: 30080, winner: 'upos-fast.bilivideo.com', nativeHost: 'upos-origin.bilivideo.com', committed: true,
    coverage: { valid: 3, started: 5, eligible: 20 }, budget: { observedBytes: 1000 }, results: [], stopReason: 'target-reached' }] };
}

test('browser retains old-resource reports and offers manual rerun when current resource differs', async () => {
  const b = browser(); await flush();
  b.status.recentRuns = [report('first')]; await b.resume(10);
  assert.match(b.elements['report-badge'].textContent, /历史记录/);
  assert.match(b.elements['report-summary'].textContent, /已确认/);
  assert.equal(b.elements['report-choice'].children.length, 1);
  assert.equal(b.elements.quick.disabled, false);
  b.elements.quick.onclick(); await flush();
  assert.equal(b.posts[0].body.action, 'quick-force');
  assert.equal(b.posts[0].body.resourceId, b.status.current[0].resourceId);
});

test('background resume clears stale pending POST without allowing its late response to cancel the next run', async () => {
  const b = browser(); await flush();
  b.elements.quick.onclick(); await flush();
  assert.equal(b.elements.quick.disabled, true);
  const oldSnapshot = b.snapshot();
  b.status.recentRuns = [report('finished-in-background')]; await b.resume(10000);
  assert.equal(b.elements.quick.disabled, false);
  assert.match(b.elements['action-result'].textContent, /已恢复操作/);
  b.elements.quick.onclick(); await flush();
  assert.equal(b.posts.length, 2);
  b.posts[0].resolve({ status: 'selected', run: report('old'), snapshot: oldSnapshot }); await flush();
  assert.equal(b.elements.quick.disabled, true, 'old request must not release the new command');
  assert.equal(b.elements['report-choice'].children.length, 1);
});

test('completion explicitly reports changed resource instead of an unqualified success toast', async () => {
  const b = browser(); await flush(); b.elements.quick.onclick(); await flush();
  const run = report('measured'); run.resources[0].resourceKey = b.posts[0].body.resourceId;
  b.status.current[0].resourceId = 'v-2222222222222222'; b.status.recentRuns = [run]; b.status.now += 10;
  b.posts[0].resolve({ status: 'selected', run, snapshot: b.snapshot() }); await flush();
  assert.match(b.elements['action-result'].textContent, /资源或网络已变化/);
  assert.match(b.elements['report-badge'].textContent, /历史记录/);
  assert.equal(b.elements.quick.disabled, false);
});
