'use strict';

const ACTIONS = ['auto', 'quick', 'quick-force', 'full', 'status', 'stop', 'pause', 'resume', 'clear-network', 'clear-all'];
function normalizeAction(value, fallback) {
  const s = String(value || '').trim().toLowerCase();
  return ACTIONS.indexOf(s) >= 0 ? s : fallback;
}
module.exports = { ACTIONS, normalizeAction };
