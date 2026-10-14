'use strict';

const rt = require('../adapters/surge/runtime');
const { createStore } = require('../core/state');
const { argumentValue } = require('../core/config');
const { panelMain } = require('../app/panel');

const done = rt.onceDone();
const e = rt.env();

panelMain({
  panelAction: e.intentParameter || argumentValue(e.argument, 'action') || 'quick',
  environment: rt.environment(),
  trigger: e.trigger,
  argument: e.argument,
  network: rt.network,
  store: createStore(rt.storeBackend()),
  now: Date.now,
  rng: Math.random,
  http: rt.httpGet,
  setTimer: rt.setTimer,
  sink: rt.log,
  loadRegistry: () => require('../../data/cdn-candidates.json'),
}).then(
  (panel) => {
    if (e.trigger === 'editor' || e.trigger === 'intent') {
      rt.log('[BiliCDN] ' + panel.title + '\n' + panel.content);
      rt.notify(panel.title, '', panel.content);
    }
    done(panel);
  },
  (err) => {
    rt.log('[BiliCDN] panel error: ' + (err && err.stack ? err.stack : err));
    done({ title: 'B站 CDN', content: '面板运行出错：' + (err && err.message ? err.message : err), style: 'error' });
  }
);
