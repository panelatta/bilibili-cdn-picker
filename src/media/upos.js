'use strict';

const { getQueryParam } = require('./url');
const { mediaHostFamily } = require('./hosts');
const { digest } = require('../core/hash');

// First supported resource family: on-demand DASH segments under /upgcxcode/
// on single-label upos/cn/ec bilivideo.com hosts or upos-*.akamaized.net.
// PCDN/MCDN, live streams, BStar and non-default ports pass through untouched.

const ID = 'upos-m4s';
const COMPATIBLE_FAMILIES = ['upos', 'akamai'];
const PATH_RE = /^\/upgcxcode\/(?:[A-Za-z0-9_%-]+\/)+[A-Za-z0-9_%.-]+\.m4s$/;

function match(parsed, method) {
  if (!parsed || String(method || '').toUpperCase() !== 'GET') return false;
  if (parsed.scheme !== 'https' || parsed.effectivePort !== 443) return false;
  if (parsed.query === null || parsed.fragment !== null) return false;
  if (!PATH_RE.test(parsed.path) || parsed.path.indexOf('/../') >= 0 || parsed.path.indexOf('/./') >= 0) return false;
  return mediaHostFamily(parsed.host) !== null;
}

function mediaTypeOf(representationId) {
  if (representationId === null) return 'unknown';
  // 302xx are the DASH audio representations (64K/132K/192K, Dolby, Hi-Res).
  return representationId >= 30200 && representationId <= 30299 ? 'audio' : 'video';
}

// The resource key covers the full path and the untouched query, i.e. one
// signed representation. Range requests of one playback share it; different
// qualities, signatures or expiries never do. The host is excluded so the
// original and rewritten requests map to the same key.
function describe(parsed) {
  const file = parsed.path.slice(parsed.path.lastIndexOf('/') + 1);
  const rm = /-(\d{1,9})\.m4s$/.exec(file);
  const representationId = rm ? Number(rm[1]) : null;
  const mediaType = mediaTypeOf(representationId);
  const segments = parsed.path.split('/');
  const groupId = segments.length >= 4 ? segments[segments.length - 2] : '';
  const deadlineRaw = getQueryParam(parsed.query, 'deadline');
  const deadlineMs = deadlineRaw && /^\d{9,11}$/.test(deadlineRaw) ? Number(deadlineRaw) * 1000 : null;
  return {
    adapter: ID,
    family: mediaHostFamily(parsed.host),
    mediaType,
    representationId,
    resourceKey: mediaType.charAt(0) + '-' + digest(parsed.path + '?' + parsed.query),
    groupKey: digest(groupId + '|' + (deadlineRaw || '')),
    deadlineMs,
    nativeHost: parsed.host,
  };
}

function isCompatibleHost(host) {
  return COMPATIBLE_FAMILIES.indexOf(mediaHostFamily(host)) >= 0;
}

module.exports = { ID, COMPATIBLE_FAMILIES, match, describe, isCompatibleHost, mediaTypeOf };
