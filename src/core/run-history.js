'use strict';
const S = require('./state');
function pick(object, keys) {
  const out = {};
  keys.forEach((key) => { if (object && object[key] !== undefined) out[key] = object[key]; });
  return out;
}
function rows(items) {
  return (Array.isArray(items) ? items : []).slice(0, 30).map((r) =>
    pick(r, ['host', 'confirmed', 'status', 'stage', 'mbps', 'elapsedMs', 'bytes']));
}
function resourceResult(r) {
  return Object.assign(pick(r, ['resourceKey', 'mediaType', 'representationId', 'nativeHost', 'mode', 'status', 'winner',
    'score', 'winnerReason', 'enoughFast', 'targetMbps', 'backups', 'stopReason', 'complete', 'partial', 'durationMs', 'committed', 'commitReason']), {
    coverage: pick(r.coverage, ['eligible', 'started', 'valid']),
    budget: pick(r.budget, ['limitBytes', 'observedBytes', 'outstandingBytes', 'unobservableBytes', 'unobservableCount', 'overrunCount']),
    results: rows(r.results),
  });
}

function publicRun(r) {
  return Object.assign(pick(r, ['runId', 'networkKey', 'network', 'mode', 'status', 'stopReason', 'startedAt', 'finishedAt']),
    { resources: (Array.isArray(r.resources) ? r.resources : []).filter(S.isObject).slice(0, 4).map(resourceResult) });
}
function loadRuns(store) {
  const list = store.readJson(S.KEYS.runHistory, []);
  const last = store.readJson(S.KEYS.lastRun, null);
  const out = Array.isArray(list) ? list.filter(S.isObject) : [];
  if (last && last.finishedAt && !out.some((r) => r.runId === last.runId)) out.push(last);
  return out.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 20).map(publicRun);
}
function saveRun(store, summary) {
  const history = loadRuns(store).filter((r) => r.runId !== summary.runId);
  store.writeJson(S.KEYS.lastRun, summary);
  store.writeJson(S.KEYS.runHistory, [publicRun(summary)].concat(history).slice(0, 20));
}
module.exports = { pick, rows, publicRun, loadRuns, saveRun };
