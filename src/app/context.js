'use strict';

const { resolveConfig } = require('../core/config');
const { networkContext } = require('../core/network');
const { randomId } = require('../core/hash');
const { KEYS, loadMeta, SCHEMA_VERSION } = require('../core/state');

function loadConfig(store, argument) {
  return resolveConfig(argument, store.readJson(KEYS.config, null));
}

// The salt is generated once; a concurrent first write by two scripts only
// costs one mismatched cache key.
function ensureMeta(store, now, rng) {
  const meta = loadMeta(store);
  if (!meta.salt) {
    meta.v = SCHEMA_VERSION;
    meta.salt = randomId(16, rng);
    meta.changedAt = meta.changedAt || now;
    store.writeJson(KEYS.meta, meta);
  }
  return meta;
}

function currentNetwork(rawNetwork, meta, config) {
  return networkContext(rawNetwork, {
    salt: meta.salt,
    generation: meta.generation,
    routeRevision: config.routeRevision,
    probePolicy: config.probePolicy,
  });
}

module.exports = { loadConfig, ensureMeta, currentNetwork };
