'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { validateModule } = require('../../tools/validate-module.cjs');
const { resolveConfig } = require('../../src/core/config');
const { buildProbeRequest } = require('../../src/core/probe');
const { mediaUrl, NATIVE } = require('../helpers/sim');

const root = path.resolve(__dirname, '../..');
const local = () => fs.readFileSync(path.join(root, 'surge/BilibiliCDNPicker.sgmodule'), 'utf8');
const remote = () => fs.readFileSync(path.join(root, 'surge/BilibiliCDNPicker.remote.sgmodule'), 'utf8');

test('both installable modules have valid arguments, script declarations and panel references', () => {
  for (const [text, isRemote] of [[local(), false], [remote(), true]]) {
    const m = validateModule(text, { remote: isRemote });
    assert.equal(Object.keys(m.defaults).length, 9);
    assert.equal(m.defaults.PROBE_POLICY, '');
    assert.equal(Object.keys(m.scripts).length, 6);
    assert.equal(Object.keys(m.panels).length, 2);
    for (const s of Object.values(m.scripts)) {
      const name = isRemote ? path.basename(new URL(s['script-path']).pathname) : s['script-path'];
      assert.ok(fs.existsSync(path.join(root, 'surge', name)), name);
    }
  }
});

test('reject the exact iOS import failure: a parameter ending with an empty colon', () => {
  assert.throws(() => validateModule(local().replace('PROBE_POLICY,DEBUG', 'PROBE_POLICY:,DEBUG')), /Malformed argument declaration: PROBE_POLICY:/);
  assert.throws(() => validateModule(local().replace('PROBE_POLICY,DEBUG', 'PROBE_POLICY:   ,DEBUG')), /Malformed argument/);
});

test('reject duplicated, undeclared and unused module arguments', () => {
  assert.throws(() => validateModule(local().replace('PROBE_POLICY,DEBUG', 'PROBE_POLICY,PROBE_POLICY,DEBUG')), /Duplicate argument/);
  assert.throws(() => validateModule(local().replace('PROBE_POLICY,', '')), /Undeclared argument/);
  assert.throws(() => validateModule(local().replace('PROBE_POLICY,', 'EXTRA:value,PROBE_POLICY,')), /Unused argument/);
});

test('reject malformed script fields, quotes and panel references', () => {
  assert.throws(() => validateModule(local().replace('engine=jsc', 'engine=jsc,engine=webview')), /duplicate field/);
  assert.throws(() => validateModule(local().replace('script-path=request-router.js, ', '')), /Missing script-path/);
  assert.throws(() => validateModule(local().replace('timeout=5', 'timeout=zero')), /Invalid timeout/);
  assert.throws(() => validateModule(local().replace('cronexp="*/15 * * * *"', 'cronexp="*/15 * * * *')), /Unclosed quote/);
  assert.throws(() => validateModule(local().replace('script-name=BiliCDN-Panel', 'script-name=BiliCDN-Runner')), /generic script/);
});

test('remote modules cannot contain local paths or credential-bearing URLs', () => {
  assert.throws(() => validateModule(local(), { remote: true }), /Invalid URL/);
  assert.throws(() => validateModule(remote().replace('https://raw.', 'https://secret@raw.'), { remote: true }), /Invalid remote script-path/);
  assert.throws(() => validateModule(local().replace('pattern=^https:', 'pattern=@@PATTERN@@^https:')), /Unexpanded build placeholder/);
});

test('default parameter substitution leaves probe routing untouched; explicit policy still works', () => {
  for (const text of [local(), remote()]) {
    const { defaults, scripts } = validateModule(text);
    const substitute = (values) => scripts['BiliCDN-Runner'].argument.replace(/\{\{\{(\w+)\}\}\}/g, (_, key) => values[key]);
    for (const policy of ['', 'DIRECT', 'My Proxy']) {
      const { config, warnings } = resolveConfig(substitute({ ...defaults, PROBE_POLICY: policy }), null);
      assert.deepEqual(warnings, []);
      assert.equal(config.probePolicy, policy);
      const request = buildProbeRequest({ config, sampleUrl: mediaUrl(), sampleHeaders: {}, host: NATIVE,
        rangeStart: 0, rangeBytes: 131072, timeoutMs: 800 });
      assert.equal(request.policy, policy || undefined);
    }
  }
});

test('remote module differs from local only in the pinned script base URL', () => {
  const { baseUrl } = JSON.parse(fs.readFileSync(path.join(root, 'tools/remote-module.json'), 'utf8'));
  assert.equal(remote().split(baseUrl).join(''), local());
});

test('build --check rejects a stale remote module instead of silently skipping it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcp-module-check-'));
  try {
    for (const name of ['src', 'surge', 'tools', 'data', 'package.json']) {
      fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
    }
    const file = path.join(dir, 'surge/BilibiliCDNPicker.remote.sgmodule');
    fs.writeFileSync(file, remote().replace('PROBE_POLICY,DEBUG', 'PROBE_POLICY:,DEBUG'));
    assert.throws(() => execFileSync(process.execPath, [path.join(dir, 'tools/build.mjs'), '--check'], { stdio: 'pipe' }),
      (err) => err.status === 1 && String(err.stderr).includes('BilibiliCDNPicker.remote.sgmodule'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
