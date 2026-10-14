'use strict';

// Runs a built surge/*.js bundle in an isolated VM context that exposes only
// Surge-style globals (no require, module, process or Buffer).

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SURGE_DIR = path.resolve(__dirname, '../../surge');

function createDevice(options) {
  const o = options || {};
  const store = new Map();
  const httpCalls = [];
  const apiCalls = [];
  const notifications = [];
  const logs = [];
  const device = {
    store,
    httpCalls,
    apiCalls,
    notifications,
    logs,
    network: o.network || { wifi: { ssid: 'Home', bssid: 'aa:bb' }, v4: { primaryInterface: 'en0', primaryAddress: '192.168.1.2' }, dns: [] },
    // host -> {delayMs, status, mbps}
    cdn: o.cdn || {},
    objectLength: o.objectLength || 32 * 1024 * 1024,
  };

  function httpGet(options, callback) {
    const host = /^https:\/\/([^/]+)/.exec(options.url)[1];
    const b = Object.assign({ delayMs: 20, status: 206 }, device.cdn[host] || {});
    httpCalls.push({ host, options });
    const m = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range || '');
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), device.objectLength - 1);
    setTimeout(() => {
      if (b.status === 'timeout') return callback('The request timed out.', null, null);
      if (b.status !== 206) return callback(null, { status: b.status, headers: {} }, new Uint8Array(0));
      callback(null, {
        status: 206,
        headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + device.objectLength, 'Content-Type': 'video/mp4' },
      }, new Uint8Array(end - start + 1));
    }, b.delayMs);
  }

  device.run = function run(name, globals) {
    const code = fs.readFileSync(path.join(SURGE_DIR, name), 'utf8');
    return new Promise((resolve, reject) => {
      let doneCount = 0;
      const context = vm.createContext(Object.assign({
        console: { log: (line) => logs.push(String(line)) },
        setTimeout,
        $done: (value) => {
          doneCount++;
          if (doneCount === 1) setImmediate(() => resolve({ value, doneCount: () => doneCount }));
        },
        $persistentStore: {
          read: (key) => (store.has(key) ? store.get(key) : null),
          write: (value, key) => {
            if (value === null) store.delete(key);
            else store.set(key, String(value));
            return true;
          },
        },
        $network: device.network,
        $environment: { system: 'iOS', 'surge-version': '5.x', language: 'zh-Hans' },
        $script: { name, type: 'test', startTime: Date.now() / 1000 },
        $httpClient: { get: httpGet },
        $httpAPI: (method, p, body, cb) => { apiCalls.push({ method, path: p, body }); if (cb) setTimeout(() => cb({}), 1); },
        $notification: { post: (...args) => notifications.push(args) },
      }, globals || {}));
      try {
        vm.runInContext(code, context, { filename: name, timeout: 5000 });
      } catch (e) {
        reject(e);
      }
      setTimeout(() => reject(new Error(name + ': $done not called within 20 s')), 20000).unref();
    });
  };
  return device;
}

module.exports = { createDevice, SURGE_DIR };
