'use strict';

const rt = require('../adapters/surge/runtime');
const { createStore } = require('../core/state');
const { handleWebRequest, response } = require('../app/web');
const done = rt.onceDone(), e = rt.env();
let registry;
handleWebRequest({ request: e.request, argument: e.argument, environment: rt.environment(), network: rt.network,
  store: createStore(rt.storeBackend()), now: Date.now, rng: Math.random, http: rt.httpGet, setTimer: rt.setTimer, sink: rt.log,
  loadRegistry: () => require('../../data/cdn-candidates.json'),
  isCandidateEnabled: (host) => {
    if (!registry) registry = require('../core/candidates').buildRegistry(require('../../data/cdn-candidates.json'));
    return !registry.disabled[host];
  },
  secureToken: () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  },
}).then(done, () => done(response(500, { error: 'internal-error' })));
