'use strict';

const rt = require('../adapters/surge/runtime');
const { createStore } = require('../core/state');
const { argumentValue } = require('../core/config');
const { panelMain } = require('../app/panel');
const registryData = require('../../data/cdn-candidates.json');

const done = rt.onceDone();
const e = rt.env();

panelMain({
  panelAction: argumentValue(e.argument, 'action') || 'quick',
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
  (panel) => done(panel),
  (err) => {
    rt.log('[BiliCDN] panel error: ' + (err && err.stack ? err.stack : err));
    done({ title: 'B站 CDN', content: '面板运行出错：' + (err && err.message ? err.message : err), style: 'error' });
  }
);
