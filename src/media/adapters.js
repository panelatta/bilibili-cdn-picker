'use strict';

const { parseUrl } = require('./url');
const upos = require('./upos');

const ADAPTERS = [upos];

// Returns null for anything not covered by a verified adapter; callers must
// then pass the request through unchanged.
function matchMediaRequest(url, method) {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  for (let i = 0; i < ADAPTERS.length; i++) {
    const adapter = ADAPTERS[i];
    if (adapter.match(parsed, method)) return { adapter, parsed, info: adapter.describe(parsed) };
  }
  return null;
}

function adapterById(id) {
  for (let i = 0; i < ADAPTERS.length; i++) if (ADAPTERS[i].ID === id) return ADAPTERS[i];
  return null;
}

function isHostCompatible(adapterId, host) {
  const adapter = adapterById(adapterId);
  return !!adapter && adapter.isCompatibleHost(host);
}

module.exports = { matchMediaRequest, adapterById, isHostCompatible };
