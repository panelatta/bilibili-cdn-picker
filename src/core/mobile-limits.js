'use strict';

// Limit simultaneous callback buffers on iOS without changing the selection
// policy, sample sizes, candidate counts, traffic budget or run deadline.
// This does not cap a single response or prove that native memory is bounded.
const CAPS = {
  quickConcurrency: 2, discoveryConcurrency: 2,
  refineConcurrency: 1, confirmConcurrency: 1,
};

function applyMobileLimits(config, environment) {
  if (!environment || environment.system !== 'iOS') return config;
  const out = Object.assign({}, config);
  Object.keys(CAPS).forEach((key) => { out[key] = Math.min(config[key], CAPS[key]); });
  return out;
}
module.exports = { applyMobileLimits, CAPS };
