'use strict';

// Small, body-free rows suitable for progress polling and final run reports.
function resultRows(measurements, limit) {
  return Object.keys(measurements || {}).map((host) => {
    const m = measurements[host];
    const confirmed = !!(m.refine && m.confirm && !m.confirmFailed && m.lastKind === 'ok');
    const sample = m.confirm || m.refine || m.coarse || {};
    return { host, confirmed, status: m.lastKind || 'pending',
      stage: m.lastStage || (m.confirm ? 'confirm' : m.refine ? 'refine' : 'coarse'),
      mbps: m.lastKind !== 'ok' ? null : confirmed ? Math.min(m.refine.mbps, m.confirm.mbps) : sample.mbps || null,
      elapsedMs: sample.elapsedMs || null, bytes: sample.bytes || null };
  }).sort((a, b) => Number(b.confirmed) - Number(a.confirmed) ||
    Number(b.status === 'ok') - Number(a.status === 'ok') || (b.mbps || 0) - (a.mbps || 0))
    .slice(0, limit || 30);
}

module.exports = { resultRows };
