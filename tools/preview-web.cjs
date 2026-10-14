'use strict';
// Loopback-only preview: real controller/state, synthetic CDN responses. Never
// forwards signed URLs or traffic to a CDN. Production entry has no previewOrigin.
const http = require('node:http');
const crypto = require('node:crypto');
const { handleWebRequest } = require('../src/app/web');
const { handleRequest } = require('../src/app/router');
const S = require('../src/core/state');
const { memoryBackend, mediaUrl, createCdn, NATIVE } = require('../tests/helpers/sim');
const backend = memoryBackend();
const network = { wifi: { ssid: 'Preview' }, v4: { primaryInterface: 'en0' } };
const cdn = createCdn({ now: Date.now, setTimer: setTimeout }, {
  [NATIVE]: { mbps: 8, latencyMs: 70 },
  'cn-hbwh-fx-01-12.bilivideo.com': { mbps: 250, latencyMs: 30 },
}, { mbps: 30, latencyMs: 150 });
const deadlineSec = Math.floor(Date.now() / 1000) + 7200;
function capture() {
  for (const rep of [30080, 30280]) handleRequest({
    request: { method: 'GET', url: mediaUrl({ rep, deadlineSec }), headers: { 'User-Agent': 'bili-preview' } },
    network, store: S.createStore(backend), now: Date.now, argument: 'mode=manual',
  });
}
let origin;
const server = http.createServer(async (req, res) => {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 4096) { res.writeHead(413); res.end(); return; } chunks.push(c); }
  capture();
  try {
    const result = await handleWebRequest({ preview: true, previewOrigin: origin,
      request: { url: origin + req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() },
      store: S.createStore(backend), network: () => network, environment: { system: 'iOS', 'surge-version': 'preview' },
      now: Date.now, rng: Math.random, http: cdn.http, setTimer: setTimeout,
      registryData: require('../data/cdn-candidates.json'), secureToken: () => crypto.randomBytes(24).toString('hex'),
    });
    res.writeHead(result.response.status, result.response.headers); res.end(result.response.body);
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'preview-error' })); console.error(e); }
});
server.listen(Number(process.env.BCP_PREVIEW_PORT || 8787), '127.0.0.1', () => {
  origin = 'http://127.0.0.1:' + server.address().port;
  console.log('Synthetic local preview: ' + origin);
});
