'use strict';

const { normalizeHostname } = require('../media/hosts');

// Configuration contract (design §11.2). Every value is type- and
// range-checked; invalid input falls back to the conservative default and is
// reported as a warning instead of reaching the scheduler.

const SCHEMA = {
  enabled: { type: 'bool', def: true },
  mode: { type: 'enum', def: 'manual', values: ['manual', 'adaptive'] },
  region: { type: 'region', def: 'SG' },
  historyPolicy: { type: 'enum', def: 'conservative', values: ['conservative', 'optimistic'] },

  shortlistLimit: { type: 'int', def: 20, min: 1, max: 40 },
  historySlots: { type: 'int', def: 5, min: 0, max: 10 },
  regionSlots: { type: 'int', def: 10, min: 0, max: 20 },
  exploreSlots: { type: 'int', def: 2, min: 0, max: 4 },
  exploreMaxSlots: { type: 'int', def: 4, min: 0, max: 4 },
  explorationRate: { type: 'number', def: 0.1, min: 0, max: 1 },
  preferredHosts: { type: 'hosts', def: [] },

  automaticFullDiscovery: { type: 'bool', def: false },
  cellularDiscovery: { type: 'bool', def: false },
  quickConcurrency: { type: 'int', def: 4, min: 1, max: 20 },
  cellularConcurrency: { type: 'int', def: 2, min: 1, max: 20 },
  discoveryConcurrency: { type: 'int', def: 8, min: 1, max: 20 },
  refineConcurrency: { type: 'int', def: 4, min: 1, max: 20 },
  confirmConcurrency: { type: 'int', def: 1, min: 1, max: 4 },

  quickTargetMiB: { type: 'number', def: 12, min: 2, max: 64 },
  cellularTargetMiB: { type: 'number', def: 4, min: 2, max: 64 },
  discoveryTargetMiB: { type: 'number', def: 100, min: 10, max: 512 },

  coarseKiB: { type: 'int', def: 128, min: 64, max: 256 },
  refineKiB: { type: 'int', def: 1024, min: 256, max: 4096 },
  quickConfirmKiB: { type: 'int', def: 1024, min: 256, max: 4096 },
  fullConfirmKiB: { type: 'int', def: 4096, min: 1024, max: 8192 },
  quickRefineTop: { type: 'int', def: 3, min: 1, max: 5 },
  fullCoarseTop: { type: 'int', def: 20, min: 1, max: 40 },
  fullRefineTop: { type: 'int', def: 5, min: 1, max: 10 },

  coarseTimeoutMs: { type: 'int', def: 800, min: 200, max: 5000 },
  coarseMinTimeoutMs: { type: 'int', def: 300, min: 100, max: 5000 },
  refineTimeoutMs: { type: 'int', def: 1500, min: 300, max: 10000 },
  refineMinTimeoutMs: { type: 'int', def: 600, min: 100, max: 10000 },
  confirmTimeoutMs: { type: 'int', def: 3000, min: 500, max: 15000 },
  rescueTimeoutMs: { type: 'int', def: 1500, min: 300, max: 10000 },
  cutoffAlpha: { type: 'number', def: 2.5, min: 1, max: 10 },
  looseProbeEvery: { type: 'int', def: 10, min: 0, max: 100 },

  resourceTtlSeconds: { type: 'int', def: 600, min: 60, max: 1200 },
  historyTtlSeconds: { type: 'int', def: 86400, min: 3600, max: 172800 },
  unknownNetworkTtlSeconds: { type: 'int', def: 1800, min: 300, max: 86400 },
  fullScanTtlSeconds: { type: 'int', def: 86400, min: 43200, max: 604800 },
  fullRetrySeconds: { type: 'int', def: 3600, min: 600, max: 86400 },
  sampleTtlSeconds: { type: 'int', def: 120, min: 30, max: 120 },
  sampleRefreshSeconds: { type: 'int', def: 20, min: 5, max: 120 },
  retryAfterFailureSeconds: { type: 'int', def: 300, min: 30, max: 3600 },

  targetMbps: { type: 'number', def: 80, min: 1, max: 2000 },
  bitrateMultiplier: { type: 'number', def: 4, min: 1, max: 20 },
  minDwellSeconds: { type: 'int', def: 60, min: 0, max: 3600 },
  improvementRatio: { type: 'number', def: 1.25, min: 1, max: 10 },
  maxSwitchesPerResource: { type: 'int', def: 3, min: 1, max: 10 },

  runDeadlineSeconds: { type: 'int', def: 60, min: 10, max: 300 },
  maxResourcesPerRun: { type: 'int', def: 2, min: 1, max: 4 },
  expandOnMiss: { type: 'bool', def: true },
  fullEarlyStop: { type: 'bool', def: false },

  routeRevision: { type: 'string', def: 'default', max: 64 },
  probePolicy: { type: 'string', def: '', max: 128 },
  probeMarker: { type: 'bool', def: true },
  probeHeaders: { type: 'list', def: ['User-Agent', 'Referer', 'Origin', 'Accept', 'Accept-Language'] },
  runnerScriptName: { type: 'string', def: 'BiliCDN-Runner', max: 64 },
  autoTriggerIntervalSeconds: { type: 'int', def: 30, min: 10, max: 3600 },
  debug: { type: 'bool', def: false },
};

const PLACEHOLDER_RE = /^\{\{\{[A-Za-z0-9_]*\}\}\}$/;

function parseArgument(raw) {
  const out = {};
  if (typeof raw !== 'string' || raw.length === 0) return out;
  raw.split('&').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0) return;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    try { value = decodeURIComponent(value); } catch (e) { /* keep raw */ }
    // Unsubstituted module placeholders mean "not configured".
    if (PLACEHOLDER_RE.test(value)) return;
    if (Object.prototype.hasOwnProperty.call(SCHEMA, key)) out[key] = value;
  });
  return out;
}

// Reads a non-config key such as `action` from the raw argument string.
function argumentValue(raw, name) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('&');
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0 && parts[i].slice(0, eq).trim() === name) {
      const value = parts[i].slice(eq + 1).trim();
      return PLACEHOLDER_RE.test(value) ? null : value;
    }
  }
  return null;
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return undefined;
}

function toList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return undefined;
  return value.split(/[,|\s]+/).map((s) => s.trim()).filter(Boolean);
}

function coerce(spec, value) {
  if (value === undefined || value === null) return undefined;
  switch (spec.type) {
    case 'bool':
      return toBool(value);
    case 'int':
    case 'number': {
      if (typeof value === 'string' && value.trim() === '') return undefined;
      const n = Number(value);
      if (!isFinite(n) || n < spec.min || n > spec.max) return undefined;
      return spec.type === 'int' ? Math.round(n) : n;
    }
    case 'enum': {
      const s = String(value).trim().toLowerCase();
      return spec.values.indexOf(s) >= 0 ? s : undefined;
    }
    case 'region': {
      const s = String(value).trim().toUpperCase();
      if (s === '' || s === 'NONE' || s === 'AUTO') return 'NONE';
      return /^[A-Z]{2}$/.test(s) ? s : undefined;
    }
    case 'string': {
      const s = String(value);
      if (s.length > spec.max || /[\u0000-\u001f\u007f]/.test(s)) return undefined;
      return s.trim();
    }
    case 'list': {
      const list = toList(value);
      if (!list) return undefined;
      return list.every((h) => /^[A-Za-z0-9-]{1,64}$/.test(h)) ? list : undefined;
    }
    case 'hosts': {
      const list = toList(value);
      if (!list) return undefined;
      const hosts = list.map(normalizeHostname);
      return hosts.every(Boolean) ? hosts.slice(0, 10) : undefined;
    }
    default:
      return undefined;
  }
}

// Precedence: defaults < module argument < persistent-store overrides.
function resolveConfig(argumentString, overrides) {
  const config = {};
  const warnings = [];
  const sources = {};
  Object.keys(SCHEMA).forEach((key) => {
    config[key] = SCHEMA[key].def;
    sources[key] = 'default';
  });
  const layers = [
    ['argument', parseArgument(argumentString)],
    ['store', overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {}],
  ];
  layers.forEach((layer) => {
    const name = layer[0];
    const values = layer[1];
    Object.keys(values).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(SCHEMA, key)) {
        if (name === 'store') warnings.push('未知配置项 ' + key);
        return;
      }
      const v = coerce(SCHEMA[key], values[key]);
      if (v === undefined) {
        warnings.push('配置项 ' + key + ' 无效，已使用 ' + JSON.stringify(config[key]));
        return;
      }
      config[key] = v;
      sources[key] = name;
    });
  });
  if (config.coarseMinTimeoutMs > config.coarseTimeoutMs) config.coarseMinTimeoutMs = config.coarseTimeoutMs;
  if (config.refineMinTimeoutMs > config.refineTimeoutMs) config.refineMinTimeoutMs = config.refineTimeoutMs;
  if (config.exploreSlots > config.exploreMaxSlots) config.exploreSlots = config.exploreMaxSlots;
  return { config, warnings, sources };
}

module.exports = { SCHEMA, parseArgument, argumentValue, resolveConfig, coerce };
