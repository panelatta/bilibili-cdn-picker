'use strict';

// Pre-filtered shortlist (design §7.1.1): native 1 + history ≤5 + region ≤10
// + exploration ≤4, deduplicated by hostname and capped by `limit`. Only the
// local registry and caches are read; nothing is sent over the network here.
// Vacancies left by duplicates or cooled-down hosts are not back-filled.

function buildShortlist(input) {
  const limit = Math.max(1, input.limit || 20);
  const slots = input.slots || {};
  const isEligible = input.isEligible || (() => null);
  const picked = [];
  const seen = {};
  const skipped = [];

  function add(host, source) {
    if (!host || seen[host] || picked.length >= limit) return false;
    const reason = isEligible(host, source);
    if (reason) {
      skipped.push({ host, source, reason });
      seen[host] = true;
      return false;
    }
    seen[host] = true;
    picked.push({ host, source });
    return true;
  }

  // The native CDN is always kept as the control, ahead of everything else.
  if (input.nativeHost) {
    seen[input.nativeHost] = true;
    picked.push({ host: input.nativeHost, source: 'native' });
  }

  let historyLeft = Math.max(0, slots.history || 0);
  const historyQueue = []
    .concat((input.priorHosts || []).map((h) => [h, 'resource']))
    .concat((input.preferredHosts || []).map((h) => [h, 'preferred']))
    .concat((input.historyHosts || []).map((h) => [h, 'history']));
  for (let i = 0; i < historyQueue.length && historyLeft > 0; i++) {
    if (add(historyQueue[i][0], historyQueue[i][1])) historyLeft--;
  }

  const region = (input.regionHosts || []).slice(0, Math.max(0, slots.region || 0));
  region.forEach((h) => add(h, 'region'));

  const exploration = input.exploration || {};
  const order = exploration.order || [];
  let cursor = order.length ? ((exploration.cursor || 0) % order.length + order.length) % order.length : 0;
  let wanted = Math.max(0, exploration.count || 0);
  const rng = input.rng || Math.random;
  for (let steps = 0; wanted > 0 && steps < order.length && picked.length < limit; steps++) {
    const host = order[cursor];
    cursor = (cursor + 1) % order.length;
    if (seen[host]) continue;
    // Small random skips combined with the rotating cursor avoid always
    // sampling the same neighbours of the cursor.
    if (rng() < 0.25) continue;
    if (add(host, 'explore')) wanted--;
  }

  return { hosts: picked, skipped, exploreCursor: cursor };
}

// Next batch for quick-mode expansion: up to `count` untested hosts from the
// global diversity order, starting at the rotating cursor.
function nextExpansionBatch(order, cursor, count, isUsable) {
  const out = [];
  if (!order.length) return { hosts: out, cursor: 0 };
  let c = ((cursor || 0) % order.length + order.length) % order.length;
  for (let steps = 0; steps < order.length && out.length < count; steps++) {
    const host = order[c];
    c = (c + 1) % order.length;
    if (isUsable(host)) out.push(host);
  }
  return { hosts: out, cursor: c };
}

// Full exploration order: native first, then known-good hosts interleaved with
// untested ones so history never starves new candidates.
function fullExplorationOrder(nativeHost, primary, rest, ratio) {
  const step = Math.max(1, ratio || 3);
  const out = [];
  const seen = {};
  function push(h) {
    if (h && !seen[h]) {
      seen[h] = true;
      out.push(h);
    }
  }
  push(nativeHost);
  const a = primary.filter((h) => h !== nativeHost);
  const b = rest.filter((h) => h !== nativeHost);
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    for (let k = 0; k < step && i < a.length; k++) push(a[i++]);
    if (j < b.length) push(b[j++]);
  }
  return out;
}

module.exports = { buildShortlist, nextExpansionBatch, fullExplorationOrder };
