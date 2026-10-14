'use strict';

const rt = require('../adapters/surge/runtime');
const { createStore } = require('../core/state');
const { handleRequest } = require('../app/router');

const done = rt.onceDone();
try {
  const e = rt.env();
  done(handleRequest({
    request: e.request,
    argument: e.argument,
    network: rt.network(),
    store: createStore(rt.storeBackend()),
    now: Date.now,
    httpApi: (method, path, body) => { rt.httpApi(method, path, body); },
    log: (line) => rt.log('[BiliCDN] ' + line),
  }));
} catch (err) {
  // Any failure on the hot path means: pass the request through untouched.
  rt.log('[BiliCDN] router error: ' + (err && err.message ? err.message : err));
  done({});
}
