'use strict';

const rt = require('../adapters/surge/runtime');
const { createStore } = require('../core/state');
const { handleNetworkChange } = require('../app/network-event');

const done = rt.onceDone();
try {
  handleNetworkChange({ store: createStore(rt.storeBackend()), now: Date.now });
} catch (err) {
  rt.log('[BiliCDN] network event error: ' + (err && err.message ? err.message : err));
}
done();
