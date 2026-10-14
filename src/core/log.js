'use strict';

// Structured events (design §12). Events carry hosts, stages, timings, byte
// counts and error classes only: never full signed URLs, cookies,
// authorization headers, SSIDs or BSSIDs.

const EVENT_NAMES = [
  'sample_captured',
  'probe_started',
  'probe_completed',
  'probe_rejected',
  'selection_confirmed',
  'selection_kept',
  'scheduling_stopped',
  'cache_invalidated',
  'fallback_selected',
  'commit_rejected',
  'run_finished',
];

const FORBIDDEN_FIELDS = { url: true, headers: true, cookie: true, authorization: true, ssid: true, bssid: true };

function sanitize(fields) {
  const out = {};
  Object.keys(fields || {}).forEach((k) => {
    if (FORBIDDEN_FIELDS[k.toLowerCase()]) return;
    const v = fields[k];
    if (typeof v === 'number') out[k] = Math.round(v * 100) / 100;
    else if (typeof v === 'string') out[k] = v.length > 120 ? v.slice(0, 120) : v;
    else if (typeof v === 'boolean' || v === null) out[k] = v;
  });
  return out;
}

// keep: events persisted in the run summary; the noisy per-probe start events
// are counted but not stored.
function createLogger(options) {
  const o = options || {};
  const now = o.now || Date.now;
  const sink = o.sink || null;
  const limit = o.limit || 60;
  const base = sanitize(o.base || {});
  const events = [];
  const counts = {};
  let dropped = 0;
  function event(name, fields) {
    counts[name] = (counts[name] || 0) + 1;
    const entry = Object.assign({ t: now(), event: name }, base, sanitize(fields));
    if (o.debug && sink) sink('[BiliCDN] ' + JSON.stringify(entry));
    if (name === 'probe_started' || (name === 'probe_completed' && !o.keepProbeCompletions)) return;
    if (events.length < limit) events.push(entry);
    else dropped++;
  }
  return {
    event,
    events,
    counts,
    droppedCount: () => dropped,
  };
}

module.exports = { createLogger, sanitize, EVENT_NAMES };
