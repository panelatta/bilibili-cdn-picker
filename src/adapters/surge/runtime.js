'use strict';

// Thin wrappers around Surge globals. Everything else in src/ receives these
// as injected dependencies so it can run under Node tests.

function global(name) {
  try {
    if (typeof globalThis !== 'undefined' && name in globalThis) return globalThis[name];
  } catch (e) { /* ignore */ }
  return undefined;
}

function env() {
  const intent = global('$intent');
  return {
    argument: typeof global('$argument') === 'string' ? global('$argument') : '',
    trigger: global('$trigger') || null,
    intentParameter: intent && typeof intent.parameter === 'string' ? intent.parameter : null,
    input: global('$input') || null,
    request: global('$request') || null,
    response: global('$response') || null,
  };
}

function network() {
  return global('$network') || {};
}

// $done must be called exactly once; later calls are ignored here as well.
function onceDone() {
  let called = false;
  return function done(value) {
    if (called) return false;
    called = true;
    const fn = global('$done');
    if (typeof fn === 'function') fn(value === undefined ? {} : value);
    return true;
  };
}

function storeBackend() {
  const ps = global('$persistentStore');
  return {
    read: (key) => (ps ? ps.read(key) : null),
    write: (value, key) => (ps ? ps.write(value, key) : false),
  };
}

// Resolves on the real completion callback only; never rejects.
function httpGet(options) {
  return new Promise((resolve) => {
    const client = global('$httpClient');
    if (!client) {
      resolve({ error: 'httpClient unavailable' });
      return;
    }
    try {
      client.get(options, (error, response, data) => resolve({ error: error || null, response, data }));
    } catch (e) {
      resolve({ error: String(e) });
    }
  });
}

function httpApi(method, path, body) {
  return new Promise((resolve) => {
    const api = global('$httpAPI');
    if (typeof api !== 'function') {
      resolve({ error: 'httpAPI unavailable' });
      return;
    }
    try {
      api(method, path, body || {}, (result) => resolve({ result }));
    } catch (e) {
      resolve({ error: String(e) });
    }
  });
}

function log(line) {
  try {
    console.log(line);
  } catch (e) { /* ignore */ }
}

function notify(title, subtitle, body) {
  const n = global('$notification');
  try {
    if (n && typeof n.post === 'function') n.post(title, subtitle || '', body || '');
  } catch (e) { /* ignore */ }
}

function setTimer(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

module.exports = { env, network, onceDone, storeBackend, httpGet, httpApi, log, notify, setTimer };
