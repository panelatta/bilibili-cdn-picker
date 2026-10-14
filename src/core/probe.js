'use strict';

const { parseUrl, replaceHost } = require('../media/url');
const { pickHeaders, getHeader, PROBE_MARKER } = require('../media/headers');
const { effectiveMbps } = require('./format');

// Range probe construction and strict sample validation (design §6.1-§6.2).
// Only a 206 whose Content-Range and actual byte length both match the
// requested range may enter a ranking.

function rangeHeader(start, bytes) {
  return 'bytes=' + start + '-' + (start + bytes - 1);
}

function buildProbeRequest(params) {
  const parsed = parseUrl(params.sampleUrl);
  if (!parsed) return null;
  const config = params.config;
  const headers = pickHeaders(params.sampleHeaders, config.probeHeaders);
  headers.Range = rangeHeader(params.rangeStart, params.rangeBytes);
  headers['Accept-Encoding'] = 'identity';
  if (config.probeMarker) headers[PROBE_MARKER] = params.runId || '1';
  const options = {
    url: replaceHost(parsed, params.host),
    headers,
    timeout: params.timeoutMs / 1000,
    'binary-mode': true,
    'auto-redirect': false,
    'auto-cookie': false,
  };
  if (config.probePolicy) options.policy = config.probePolicy;
  return options;
}

function parseContentRange(value) {
  if (typeof value !== 'string') return null;
  let m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(value);
  if (m) {
    const r = { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
    if (r.end < r.start || (r.total !== null && r.end >= r.total)) return null;
    return r;
  }
  m = /^\s*bytes\s+\*\/(\d+)\s*$/i.exec(value);
  if (m) return { unsatisfied: true, total: Number(m[1]) };
  return null;
}

function classifyError(error) {
  const s = String(error || '').toLowerCase();
  if (/timed? ?out|timeout/.test(s)) return 'timeout';
  if (/hostname|dns|resolve|nxdomain|name or service/.test(s)) return 'dns';
  if (/ssl|tls|certificate|secure connection|handshake/.test(s)) return 'tls';
  if (/connect|refused|reset|unreachable|connection was lost|network/.test(s)) return 'connect';
  return 'error';
}

function dataLength(data) {
  if (data === null || data === undefined) return 0;
  if (typeof data.byteLength === 'number') return data.byteLength;
  if (typeof data === 'string') return data.length;
  if (typeof data.length === 'number') return data.length;
  return null;
}

function parseRetryAfter(value, nowMs) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (/^\s*\d+\s*$/.test(value)) return Math.min(86400, Number(value));
  const at = Date.parse(value);
  if (!isFinite(at)) return null;
  return Math.max(0, Math.min(86400, Math.round((at - nowMs) / 1000)));
}

const TEXTUAL_TYPE = /text\/|application\/(?:json|xml|javascript)|\+xml|\+json/i;

// spec: {host, stage, rangeStart, rangeBytes, timeoutMs, startedAt, order}
// outcome: {error, response, data, completedAt}
function evaluateProbe(spec, outcome) {
  const completedAt = outcome.completedAt;
  const result = {
    host: spec.host,
    stage: spec.stage,
    order: spec.order,
    rangeStart: spec.rangeStart,
    rangeBytes: spec.rangeBytes,
    timeoutMs: spec.timeoutMs,
    startedAt: spec.startedAt,
    completedAt,
    elapsedMs: Math.max(1, completedAt - spec.startedAt),
    ok: false,
    kind: null,
    status: null,
    bytes: null,
    mbps: null,
    objectLength: null,
    retryAfterSec: null,
  };
  if (outcome.error || !outcome.response) {
    result.kind = outcome.error ? classifyError(outcome.error) : 'error';
    return result;
  }
  const response = outcome.response;
  const status = Number(response.status !== undefined ? response.status : response.statusCode);
  result.status = isFinite(status) ? status : null;
  result.bytes = typeof outcome.bodyBytes === 'number' ? outcome.bodyBytes : dataLength(outcome.data);
  const headers = response.headers;
  const cr = parseContentRange(getHeader(headers, 'Content-Range'));
  if (cr && cr.total !== null) result.objectLength = cr.total;

  if (status === 206) {
    const type = getHeader(headers, 'Content-Type') || '';
    const expectedEnd = spec.rangeStart + spec.rangeBytes - 1;
    if (TEXTUAL_TYPE.test(type) || outcome.bodyKind === 'text' || typeof outcome.data === 'string') result.kind = 'error-body';
    else if (!cr || cr.unsatisfied) result.kind = 'bad-content-range';
    else if (cr.start !== spec.rangeStart) result.kind = 'range-mismatch';
    else if (result.bytes !== cr.end - cr.start + 1) result.kind = 'length-mismatch';
    else if (cr.end !== expectedEnd) {
      // A complete but shorter object: usable only after the whole stage
      // switches to the same shorter range.
      result.kind = cr.total !== null && cr.end === cr.total - 1 && cr.end < expectedEnd ? 'short-object' : 'range-mismatch';
    } else {
      result.ok = true;
      result.kind = 'ok';
      result.mbps = effectiveMbps(result.bytes, result.elapsedMs);
    }
    return result;
  }
  if (status === 200) result.kind = 'range-ignored';
  else if (status >= 300 && status < 400) result.kind = 'redirect';
  else if (status === 403) result.kind = 'forbidden';
  else if (status === 404 || status === 410) result.kind = 'not-found';
  else if (status === 416) {
    result.kind = 'range-unsatisfiable';
    if (cr && cr.unsatisfied) result.objectLength = cr.total;
  } else if (status === 429) {
    result.kind = 'rate-limited';
    result.retryAfterSec = parseRetryAfter(getHeader(headers, 'Retry-After'), completedAt);
  } else if (status >= 500 && status < 600) result.kind = 'server-error';
  else result.kind = 'http-error';
  return result;
}

module.exports = { rangeHeader, buildProbeRequest, parseContentRange, classifyError, evaluateProbe, parseRetryAfter };
