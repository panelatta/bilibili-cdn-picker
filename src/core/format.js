'use strict';

const KiB = 1024;
const MiB = 1024 * 1024;

// Whole-request rate including DNS, TLS, TTFB and transfer; not pure link bandwidth.
function effectiveMbps(bytes, elapsedMs) {
  const ms = elapsedMs > 0 ? elapsedMs : 1;
  return (bytes * 8) / (ms / 1000) / 1e6;
}

function effectiveMiBps(bytes, elapsedMs) {
  const ms = elapsedMs > 0 ? elapsedMs : 1;
  return bytes / MiB / (ms / 1000);
}

function round(value, digits) {
  const f = Math.pow(10, digits === undefined ? 2 : digits);
  return Math.round(value * f) / f;
}

function formatBytes(bytes) {
  if (!(bytes > 0)) return '0 MiB';
  if (bytes < MiB) return round(bytes / KiB, 0) + ' KiB';
  return round(bytes / MiB, 1) + ' MiB';
}

function formatMbps(mbps) {
  if (!(mbps >= 0)) return '-';
  return (mbps >= 100 ? round(mbps, 0) : round(mbps, 1)) + ' Mbps';
}

function formatAge(ms) {
  if (!(ms >= 0)) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒前';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' 分钟前';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
}

function shortHost(host) {
  return String(host || '-').replace(/\.bilivideo\.com$/, '').replace(/\.akamaized\.net$/, ' (akamai)');
}

module.exports = { KiB, MiB, effectiveMbps, effectiveMiBps, round, formatBytes, formatMbps, formatAge, shortHost };
