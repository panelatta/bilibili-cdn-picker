'use strict';

const S = require('../core/state');

// network-changed event: bump the network generation. In-flight runs see the
// new generation and refuse to commit; unknown-network profiles reset.
function handleNetworkChange(ctx) {
  const store = ctx.store;
  const meta = S.loadMeta(store);
  meta.v = S.SCHEMA_VERSION;
  meta.generation = (meta.generation || 0) + 1;
  meta.changedAt = ctx.now();
  store.writeJson(S.KEYS.meta, meta);
  return meta.generation;
}

module.exports = { handleNetworkChange };
