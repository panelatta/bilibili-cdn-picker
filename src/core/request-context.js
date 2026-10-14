'use strict';

const { digest } = require('./hash');

// Bounded request-ID slots avoid a shared read/modify/write map on the hot
// path. Collisions/expiry lose observation, never attribute it to another ID.
const PREFIX = 'BiliCDNPicker.request.';
const SLOTS = 256;
const TTL_MS = 5 * 60 * 1000;

function slot(id) {
  if (typeof id !== 'string' || !id || id.length > 256) return null;
  return PREFIX + (parseInt(digest(id).slice(-4), 16) % SLOTS);
}

function recordRequest(store, id, context, now) {
  const key = slot(id);
  if (!key) return false;
  return store.writeJson(key, Object.assign({}, context, { id, capturedAt: now, expiresAt: now + TTL_MS }));
}

function requestContext(store, id, resourceKey, now) {
  const key = slot(id);
  const value = key && store.readJson(key, null);
  if (!value || value.id !== id || value.resourceKey !== resourceKey || !(value.expiresAt > now)) return null;
  return value;
}

function clearRequestContexts(store) {
  for (let i = 0; i < SLOTS; i++) store.remove(PREFIX + i);
}

module.exports = { recordRequest, requestContext, clearRequestContexts, slot, SLOTS, TTL_MS };
