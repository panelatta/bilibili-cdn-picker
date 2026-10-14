'use strict';

const rt = require('../adapters/surge/runtime');
const { createStore } = require('../core/state');
const { handleResponse } = require('../app/observer');

const done = rt.onceDone();
try {
  const e = rt.env();
  handleResponse({
    request: e.request,
    response: e.response,
    argument: e.argument,
    network: rt.network(),
    store: createStore(rt.storeBackend()),
    now: Date.now,
    log: (line) => rt.log('[BiliCDN] ' + line),
  });
} catch (err) {
  rt.log('[BiliCDN] observer error: ' + (err && err.message ? err.message : err));
}
// The response is always delivered untouched.
done({});
