'use strict';

// Hostname validation and media-host classification. A candidate "hostname"
// must be a bare DNS name: no scheme, path, userinfo, port or control chars.

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeHostname(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (host.length === 0 || host.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  for (let i = 0; i < labels.length; i++) {
    if (!LABEL_RE.test(labels[i])) return null;
  }
  return host;
}

// Each family is one label in front of an exact registrable suffix, so
// "bilivideo.com.attacker.example", "evilbilivideo.com" and multi-label PCDN
// names such as "x.mcdn.bilivideo.com" never match.
const MEDIA_HOST_FAMILIES = [
  { family: 'upos', suffix: '.bilivideo.com', label: /^(?:upos|cn|ec)-[a-z0-9-]*[a-z0-9]$/ },
  { family: 'akamai', suffix: '.akamaized.net', label: /^upos-[a-z0-9-]*[a-z0-9]$/ },
];

function mediaHostFamily(value) {
  const host = normalizeHostname(value);
  if (!host) return null;
  for (let i = 0; i < MEDIA_HOST_FAMILIES.length; i++) {
    const f = MEDIA_HOST_FAMILIES[i];
    if (host.length <= f.suffix.length || host.slice(-f.suffix.length) !== f.suffix) continue;
    const label = host.slice(0, -f.suffix.length);
    if (label.indexOf('.') >= 0) return null;
    if (label.indexOf('mcdn') >= 0) return null;
    return f.label.test(label) ? f.family : null;
  }
  return null;
}

module.exports = { normalizeHostname, mediaHostFamily, MEDIA_HOST_FAMILIES };
