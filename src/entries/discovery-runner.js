'use strict';

const rt = require('../adapters/surge/runtime');
const { createStore } = require('../core/state');
const { argumentValue } = require('../core/config');
const { runAction, normalizeAction } = require('../app/runner');
const { statusText } = require('../app/panel');
const registryData = require('../../data/cdn-candidates.json');

const done = rt.onceDone();
const e = rt.env();
// Shortcuts may pass an action (quick, full, stop, pause, resume, clear-network,
// clear-all); cron timers and HTTP-API evaluations run "auto".
const action = normalizeAction(e.intentParameter || argumentValue(e.argument, 'action'), 'auto');

runAction({
  action,
  trigger: e.trigger,
  argument: e.argument,
  network: rt.network,
  store: createStore(rt.storeBackend()),
  now: Date.now,
  rng: Math.random,
  http: rt.httpGet,
  setTimer: rt.setTimer,
  sink: rt.log,
  registryData,
}).then(
  (result) => {
    if (!result.silent) {
      const r = (result.resources || [])[0];
      const detail = r && r.winner ? r.winner + ' ' + r.score + ' Mbps' : statusText(result.status);
      rt.log('[BiliCDN] ' + action + ': ' + result.status + (r ? ' / ' + r.stopReason : '') + ' / ' + detail);
      if (e.trigger === 'intent') rt.notify('B站 CDN', action, detail);
    }
    done();
  },
  (err) => {
    rt.log('[BiliCDN] runner error: ' + (err && err.stack ? err.stack : err));
    done();
  }
);
