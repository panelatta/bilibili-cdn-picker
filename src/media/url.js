'use strict';

// Byte-preserving URL handling. Only the authority is ever replaced; path,
// query and fragment are copied verbatim (no re-encoding, no reordering).

const MAX_URL_LENGTH = 8192;
const URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/;
const AUTHORITY_RE = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/;
const DEFAULT_PORTS = { http: 80, https: 443 };

function parseUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  // Control characters, spaces and backslashes never appear in a valid media URL.
  if (/[\u0000- \u007f\\]/.test(raw)) return null;
  const m = URL_RE.exec(raw);
  if (!m) return null;
  const authority = m[2];
  const am = AUTHORITY_RE.exec(authority);
  // Rejects userinfo ("@"), IPv6 literals and empty hosts.
  if (!am) return null;
  const port = am[2] === undefined ? null : Number(am[2]);
  if (port !== null && (port < 1 || port > 65535)) return null;
  const scheme = m[1].toLowerCase();
  const prefixLength = m[1].length + 3;
  return {
    raw,
    scheme,
    authority,
    host: am[1].toLowerCase(),
    port,
    effectivePort: port === null ? DEFAULT_PORTS[scheme] || null : port,
    path: m[3] || '',
    query: m[4] === undefined ? null : m[4].slice(1),
    fragment: m[5] === undefined ? null : m[5].slice(1),
    prefix: raw.slice(0, prefixLength),
    rest: raw.slice(prefixLength + authority.length),
  };
}

// Keeps everything after the authority byte-for-byte. Callers must have
// validated the new host; ports are dropped deliberately (adapters only accept
// default-port HTTP/HTTPS URLs).
function replaceHost(parsed, newHost) {
  return parsed.prefix + newHost + parsed.rest;
}

// Returns the raw (still percent-encoded) value of the first matching
// parameter, '' for a present-but-empty value, or null when absent.
function getQueryParam(query, name) {
  if (query === null || query === undefined) return null;
  const parts = query.split('&');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (key === name) return eq < 0 ? '' : part.slice(eq + 1);
  }
  return null;
}

module.exports = { parseUrl, replaceHost, getQueryParam, MAX_URL_LENGTH };
