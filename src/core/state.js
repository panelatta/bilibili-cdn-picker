'use strict';

// Persistent state layout (design §8). Each key has exactly one writer role
// so concurrent scripts never read-modify-write the same entry:
//   samples   <- request router        failures <- response observer
//   decisions <- discovery runner      state    <- discovery runner
//   meta      <- network event (+ one-time salt init)
//   control   <- panel / shortcuts     trigger  <- request router (adaptive)
// Simple key-value writes are not atomic; the lease is best effort only and
// commits re-validate task identity instead of trusting a lock field.

const PREFIX = 'BiliCDNPicker.';
const KEYS = {
  config: PREFIX + 'config',
  meta: PREFIX + 'meta',
  samples: PREFIX + 'samples',
  decisions: PREFIX + 'decisions',
  failures: PREFIX + 'failures',
  state: PREFIX + 'state',
  lease: PREFIX + 'lease',
  control: PREFIX + 'control',
  trigger: PREFIX + 'trigger',
  lastRun: PREFIX + 'lastRun',
};
const SCHEMA_VERSION = 1;
const LIMITS = { samples: 8, decisions: 40, networks: 8, failures: 40, failureHosts: 60, profiles: 8, ranking: 80, attempts: 40 };

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function createStore(backend) {
  const problems = [];
  function read(key) {
    try {
      const raw = backend.read(key);
      return raw === undefined ? null : raw;
    } catch (e) {
      problems.push({ key, problem: 'read-failed' });
      return null;
    }
  }
  return {
    problems,
    readRaw: read,
    // Corrupt JSON degrades to the fallback and is reported, never thrown.
    readJson(key, fallback) {
      const raw = read(key);
      if (raw === null || raw === '') return fallback;
      try {
        const value = JSON.parse(raw);
        return value === null ? fallback : value;
      } catch (e) {
        problems.push({ key, problem: 'corrupt' });
        return fallback;
      }
    },
    writeJson(key, value) {
      try {
        const ok = backend.write(value === null ? null : JSON.stringify(value), key);
        if (ok === false) problems.push({ key, problem: 'write-failed' });
        return ok !== false;
      } catch (e) {
        problems.push({ key, problem: 'write-failed' });
        return false;
      }
    },
    remove(key) {
      try {
        backend.write(null, key);
        return true;
      } catch (e) {
        problems.push({ key, problem: 'write-failed' });
        return false;
      }
    },
  };
}

// Keeps the `limit` entries with the largest `field` value.
function pruneMap(map, limit, field) {
  const keys = Object.keys(map);
  if (keys.length <= limit) return map;
  keys.sort((a, b) => (map[b][field] || 0) - (map[a][field] || 0));
  const out = {};
  keys.slice(0, limit).forEach((k) => { out[k] = map[k]; });
  return out;
}

function versioned(raw, build) {
  if (!isObject(raw) || raw.v !== SCHEMA_VERSION) return build({});
  return build(raw);
}

function loadMeta(store) {
  return versioned(store.readJson(KEYS.meta, null), (raw) => ({
    v: SCHEMA_VERSION,
    salt: typeof raw.salt === 'string' && /^[a-z0-9]{8,32}$/.test(raw.salt) ? raw.salt : null,
    generation: Number.isInteger(raw.generation) && raw.generation >= 0 ? raw.generation : 0,
    changedAt: typeof raw.changedAt === 'number' ? raw.changedAt : null,
  }));
}

function loadSamples(store) {
  return versioned(store.readJson(KEYS.samples, null), (raw) => {
    const items = {};
    const src = isObject(raw.items) ? raw.items : {};
    Object.keys(src).forEach((k) => {
      const s = src[k];
      if (isObject(s) && typeof s.url === 'string' && typeof s.nativeHost === 'string' && typeof s.capturedAt === 'number') {
        items[k] = s;
      }
    });
    return { v: SCHEMA_VERSION, items };
  });
}

function loadDecisions(store) {
  return versioned(store.readJson(KEYS.decisions, null), (raw) => {
    const items = {};
    const src = isObject(raw.items) ? raw.items : {};
    Object.keys(src).forEach((k) => {
      const d = src[k];
      if (isObject(d) && typeof d.winner === 'string' && typeof d.expiresAt === 'number' && typeof d.networkKey === 'string') {
        d.backups = Array.isArray(d.backups) ? d.backups.filter((h) => typeof h === 'string') : [];
        items[k] = d;
      }
    });
    const networks = {};
    const nsrc = isObject(raw.networks) ? raw.networks : {};
    Object.keys(nsrc).forEach((k) => {
      const n = nsrc[k];
      if (isObject(n) && Array.isArray(n.hosts) && typeof n.expiresAt === 'number') networks[k] = n;
    });
    return { v: SCHEMA_VERSION, items, networks };
  });
}

function loadFailures(store) {
  return versioned(store.readJson(KEYS.failures, null), (raw) => ({
    v: SCHEMA_VERSION,
    resources: isObject(raw.resources) ? raw.resources : {},
    hosts: isObject(raw.hosts) ? raw.hosts : {},
  }));
}

function emptyProfile(net, now) {
  return {
    key: net.key,
    label: net.label,
    type: net.type,
    known: net.known,
    createdAt: now,
    updatedAt: now,
    lastAttemptAt: null,
    lastFullScanAt: null,
    lastFullAttemptAt: null,
    lastFullCoverage: null,
    explorationPending: false,
    exploreCursor: null,
    ranking: {},
    cooldowns: {},
    strikes: {},
  };
}

function loadState(store) {
  return versioned(store.readJson(KEYS.state, null), (raw) => ({
    v: SCHEMA_VERSION,
    candidateRevision: typeof raw.candidateRevision === 'string' ? raw.candidateRevision : null,
    profiles: isObject(raw.profiles) ? raw.profiles : {},
    attempts: isObject(raw.attempts) ? raw.attempts : {},
  }));
}

function loadControl(store) {
  const raw = store.readJson(KEYS.control, null);
  return {
    paused: isObject(raw) && raw.paused === true,
    stopRequestedAt: isObject(raw) && typeof raw.stopRequestedAt === 'number' ? raw.stopRequestedAt : null,
  };
}

module.exports = {
  KEYS,
  LIMITS,
  SCHEMA_VERSION,
  createStore,
  pruneMap,
  loadMeta,
  loadSamples,
  loadDecisions,
  loadFailures,
  loadState,
  loadControl,
  emptyProfile,
  isObject,
};
