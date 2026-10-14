'use strict';

const { normalizeHostname, mediaHostFamily } = require('../media/hosts');

// Candidate registry (design §5.1). Location, vendor and pool are only used
// for display and exploration diversity; they never remove a node from the
// global list.

function buildRegistry(data) {
  const warnings = [];
  const list = [];
  const byHost = {};
  const src = data && typeof data === 'object' ? data : {};
  const disabled = {};
  (Array.isArray(src.candidates) ? src.candidates : []).forEach((entry) => {
    const host = normalizeHostname(entry && entry.hostname);
    if (host && entry.enabled === false) disabled[host] = true;
  });
  const pools = src.pools && typeof src.pools === 'object' ? src.pools : {};
  (Array.isArray(src.candidates) ? src.candidates : []).forEach((entry) => {
    const hostname = normalizeHostname(entry && entry.hostname);
    const family = hostname && mediaHostFamily(hostname);
    if (!hostname || !family) {
      warnings.push('拒绝无效候选 ' + String(entry && entry.hostname).slice(0, 80));
      return;
    }
    if (disabled[hostname] || byHost[hostname]) return;
    const item = {
      hostname,
      family,
      pool: typeof entry.pool === 'string' ? entry.pool : null,
      poolLabel: typeof entry.pool === 'string' && typeof pools[entry.pool] === 'string' ? pools[entry.pool] : null,
      source: typeof entry.source === 'string' ? entry.source : 'unknown',
    };
    byHost[hostname] = item;
    list.push(item);
  });
  const regions = {};
  const rawRegions = src.regions && typeof src.regions === 'object' ? src.regions : {};
  Object.keys(rawRegions).forEach((code) => {
    if (!/^[A-Z]{2}$/.test(code)) return;
    const nodes = rawRegions[code] && Array.isArray(rawRegions[code].nodes) ? rawRegions[code].nodes : [];
    const seen = {};
    regions[code] = nodes.map(normalizeHostname).filter((h) => {
      if (!h || seen[h] || !byHost[h]) return false;
      seen[h] = true;
      return true;
    });
  });
  return {
    revision: typeof src.revision === 'string' ? src.revision : 'unknown',
    list,
    byHost,
    disabled,
    regions,
    diversityOrder: diversityOrder(list),
    warnings,
  };
}

// Round-robin across pools so consecutive exploration picks hit different
// CDN pools; pool-less hosts form their own buckets.
function diversityOrder(list) {
  const buckets = [];
  const index = {};
  list.forEach((item) => {
    const key = item.pool || 'host:' + item.hostname;
    if (index[key] === undefined) {
      index[key] = buckets.length;
      buckets.push([]);
    }
    buckets[index[key]].push(item.hostname);
  });
  const out = [];
  for (let round = 0; out.length < list.length; round++) {
    buckets.forEach((bucket) => {
      if (round < bucket.length) out.push(bucket[round]);
    });
  }
  return out;
}

function regionHosts(registry, region) {
  if (!registry || !region || region === 'NONE') return [];
  return registry.regions[region] ? registry.regions[region].slice() : [];
}

function describeHost(registry, host) {
  const item = registry && registry.byHost[host];
  return item && item.poolLabel ? item.poolLabel : null;
}

module.exports = { buildRegistry, diversityOrder, regionHosts, describeHost };
