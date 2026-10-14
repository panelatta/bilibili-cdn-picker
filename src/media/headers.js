'use strict';

const PROBE_MARKER = 'X-BCP-Probe';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getHeader(headers, name) {
  if (!isPlainObject(headers)) return null;
  const lower = name.toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === lower) {
      const value = headers[keys[i]];
      return value === undefined || value === null ? null : String(value);
    }
  }
  return null;
}

function withoutHeaders(headers, names) {
  const drop = {};
  names.forEach((n) => { drop[n.toLowerCase()] = true; });
  const out = {};
  if (!isPlainObject(headers)) return out;
  Object.keys(headers).forEach((key) => {
    if (!drop[key.toLowerCase()]) out[key] = headers[key];
  });
  return out;
}

// Replaces every case variant of Host with a single "Host" field so the
// request never carries both an old "host" and a new "Host". An HTTP/2
// ":authority" pseudo field, if exposed, is kept in sync too.
function withHost(headers, host) {
  const out = withoutHeaders(headers, ['host']);
  Object.keys(out).forEach((key) => {
    if (key.toLowerCase() === ':authority') out[key] = host;
  });
  out.Host = host;
  return out;
}

function isSafeHeaderValue(value) {
  return typeof value === 'string' && value.length <= 2048 && !/[\r\n\u0000]/.test(value);
}

// Copies only allow-listed request headers (original casing). Cookie and
// Authorization are never in the default list.
function pickHeaders(headers, allowlist) {
  const allow = {};
  (allowlist || []).forEach((n) => { allow[String(n).toLowerCase()] = true; });
  delete allow.cookie;
  delete allow.authorization;
  delete allow.host;
  delete allow.range;
  const out = {};
  if (!isPlainObject(headers)) return out;
  Object.keys(headers).forEach((key) => {
    const value = headers[key];
    if (allow[key.toLowerCase()] && isSafeHeaderValue(value)) out[key] = value;
  });
  return out;
}

function hasProbeMarker(headers) {
  return getHeader(headers, PROBE_MARKER) !== null;
}

module.exports = { PROBE_MARKER, getHeader, withHost, withoutHeaders, pickHeaders, hasProbeMarker, isPlainObject };
