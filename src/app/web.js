'use strict';

const { parseUrl } = require('../media/url');
const { getHeader } = require('../media/headers');
const S = require('../core/state');
const { SCHEMA, coerce } = require('../core/config');
const { webStatus, SETTINGS } = require('./web-status');
const { publicRun } = require('../core/run-history');

const TOKEN_KEY = 'BiliCDNPicker.webToken';
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };

function response(status, body, type) {
  return { response: { status, headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': type || 'application/json; charset=utf-8' }),
    body: typeof body === 'string' ? body : JSON.stringify(body) } };
}

async function handleWebRequest(ctx) {
  const req = ctx.request || {}, parsed = parseUrl(req.url || '');
  const origin = parsed ? parsed.scheme + '://' + parsed.host + (parsed.port && parsed.port !== (parsed.scheme === 'https' ? 443 : 80) ? ':' + parsed.port : '') : '';
  const allowed = ctx.previewOrigin ? origin === ctx.previewOrigin :
    !!parsed && parsed.host === 'bcp.test' && ((parsed.scheme === 'https' && parsed.effectivePort === 443) || (parsed.scheme === 'http' && parsed.effectivePort === 80));
  if (!allowed) return response(404, { error: 'not-found' });
  const method = String(req.method || 'GET').toUpperCase(), pathname = parsed.path || '/';
  if (method === 'OPTIONS') return response(403, { error: 'cross-origin-denied' });

  if (method === 'GET' && pathname === '/') {
    let token = ctx.store.readJson(TOKEN_KEY, null);
    if (!/^[a-f0-9]{48}$/.test(token || '')) {
      token = ctx.secureToken();
      if (!/^[a-f0-9]{48}$/.test(token || '') || !ctx.store.writeJson(TOKEN_KEY, token)) return response(503, { error: 'token-unavailable' });
    }
    token = ctx.store.readJson(TOKEN_KEY, null);
    if (!/^[a-f0-9]{48}$/.test(token || '')) return response(503, { error: 'token-unavailable' });
    const html = require('../web/assets.json').html.replace('__BCP_TOKEN__', token);
    return response(200, html, 'text/html; charset=utf-8');
  }
  const assets = {
    '/app.js': () => [require('../web/assets.json').js, 'text/javascript; charset=utf-8'],
    '/app.css': () => [require('../web/assets.json').css, 'text/css; charset=utf-8'],
    '/icon.svg': () => [require('../web/assets.json').icon, 'image/svg+xml'],
    '/manifest.webmanifest': () => [JSON.stringify({ name: 'Bilibili CDN Picker', short_name: 'CDN Picker', start_url: '/', scope: '/',
      display: 'standalone', background_color: '#101b25', theme_color: '#101b25', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] }), 'application/manifest+json'],
  };
  if (method === 'GET' && assets[pathname]) return response(200, ...assets[pathname]());

  const token = ctx.store.readJson(TOKEN_KEY, null), callerOrigin = getHeader(req.headers, 'Origin');
  if (!token || getHeader(req.headers, 'X-BCP-Token') !== token) return response(401, { error: 'session-expired' });
  if (callerOrigin && callerOrigin !== origin) return response(403, { error: 'cross-origin-denied' });
  if (method === 'GET' && pathname === '/api/status') return response(200, webStatus(ctx));
  if (method !== 'POST' || !['/api/control', '/api/settings'].includes(pathname)) return response(404, { error: 'not-found' });
  if (!(getHeader(req.headers, 'Content-Type') || '').toLowerCase().startsWith('application/json')) return response(415, { error: 'json-required' });
  if (typeof req.body !== 'string' || req.body.length > 4096) return response(400, { error: 'invalid-body' });
  let body;
  try { body = JSON.parse(req.body); } catch (e) { return response(400, { error: 'invalid-json' }); }
  if (!S.isObject(body)) return response(400, { error: 'invalid-body' });

  if (pathname === '/api/settings') {
    const lease = ctx.store.readJson(S.KEYS.lease, null);
    if (lease && lease.expiresAt > ctx.now()) return response(409, { error: 'busy' });
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !SETTINGS.includes(key))) return response(400, { error: 'unknown-setting' });
    const values = {};
    for (const key of keys) {
      const value = coerce(SCHEMA[key], body[key]);
      if (value === undefined) return response(400, { error: 'invalid-setting', field: key });
      values[key] = value;
    }
    const old = ctx.store.readJson(S.KEYS.config, {});
    if (!ctx.store.writeJson(S.KEYS.config, Object.assign({}, S.isObject(old) ? old : {}, values))) return response(503, { error: 'store-unavailable' });
    return response(200, webStatus(ctx));
  }

  const actions = ['quick', 'quick-force', 'full', 'stop', 'pause', 'resume', 'clear-network'];
  if (!actions.includes(body.action)) return response(400, { error: 'invalid-action' });
  if (['quick', 'quick-force', 'full'].includes(body.action) &&
      (!/^[vau]-[a-f0-9]{16}$/.test(body.resourceId || ''))) return response(400, { error: 'select-resource' });
  const { runAction } = require('./runner');
  // This HTTP script owns the task until completion. The browser keeps the
  // POST open while separate GETs poll progress; no post-$done background work.
  const result = await runAction(Object.assign({}, ctx, { trigger: 'button', action: body.action === 'quick' ? 'quick-force' : body.action, resourceKey: body.resourceId, manualReselect: true }));
  return response(result.status === 'busy' ? 409 : 200, { status: result.status, run: result.runId ? publicRun(result) : null, snapshot: webStatus(ctx) });
}
module.exports = { handleWebRequest, TOKEN_KEY, response };
