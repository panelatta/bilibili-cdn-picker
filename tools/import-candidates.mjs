// Convert bilibili-cdn-switcher's src/cdn-list.json into data/cdn-candidates.json.
//
// Usage: node tools/import-candidates.mjs <cdn-list.json> [data/cdn-candidates.json] [--commit <sha>]
// Fetch the pinned upstream file first, for example:
//   curl -o /tmp/cdn-list.json https://raw.githubusercontent.com/a0972199950/bilibili-cdn-switcher/210cacd1426ba2301ec647dd90bc8957b7634196/src/cdn-list.json
// The tool only parses JSON; every hostname is re-validated and deduplicated.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeHostname, mediaHostFamily } = require('../src/media/hosts.js');

const UPSTREAM = {
  project: 'bilibili-cdn-switcher',
  url: 'https://github.com/a0972199950/bilibili-cdn-switcher',
  commit: '210cacd1426ba2301ec647dd90bc8957b7634196',
  file: 'src/cdn-list.json',
  license: 'Bilibili CDN Switcher Source-Available License 1.0',
  copyright: 'Copyright (c) 2024–present John H',
  notice: '候选主机、pool 标注与地区推荐表派生自上游 CDN 节点清单，仅供个人非商业使用；保留上游署名与许可证说明，不暗示上游背书。',
};

const args = process.argv.slice(2);
const commitIndex = args.indexOf('--commit');
if (commitIndex >= 0) {
  const sha = args.splice(commitIndex, 2)[1];
  if (!/^[0-9a-f]{40}$/.test(sha || '')) {
    console.error('--commit needs a full 40-character commit hash');
    process.exit(2);
  }
  UPSTREAM.commit = sha;
}
const [input, output = 'data/cdn-candidates.json'] = args;
if (!input) {
  console.error('usage: node tools/import-candidates.mjs <cdn-list.json> [output] [--commit <sha>]');
  process.exit(2);
}

const upstream = JSON.parse(readFileSync(input, 'utf8'));
if (!Array.isArray(upstream.options) || !Array.isArray(upstream.countries)) {
  throw new Error('Unexpected upstream format: options/countries missing');
}

const pools = {};
for (const [key, label] of Object.entries(upstream.pools || {})) {
  if (/^[a-z0-9-]{1,40}$/.test(key) && label && typeof label.zh_CN === 'string') pools[key] = label.zh_CN.slice(0, 40);
}

const seen = new Set();
const rejected = [];
const candidates = [];
for (const option of upstream.options) {
  const hostname = normalizeHostname(option && option.value);
  const family = hostname && mediaHostFamily(hostname);
  if (!hostname || !family) {
    rejected.push(String(option && option.value));
    continue;
  }
  if (seen.has(hostname)) continue;
  seen.add(hostname);
  candidates.push({
    hostname,
    family,
    pool: typeof option.pool === 'string' && pools[option.pool] ? option.pool : null,
    source: 'bcs-options',
    enabled: true,
  });
}

const regions = {};
for (const country of upstream.countries) {
  if (!country || !/^[A-Z]{2}$/.test(country.code) || !Array.isArray(country.nodes)) continue;
  regions[country.code] = {
    dial: Number.isInteger(country.dial) ? country.dial : null,
    nodes: [...new Set(country.nodes.map(normalizeHostname).filter((h) => h && seen.has(h)))],
  };
}

const data = {
  schemaVersion: 1,
  revision: 'bcs-' + UPSTREAM.commit.slice(0, 7) + '-r1',
  importedAt: new Date().toISOString().slice(0, 10),
  source: UPSTREAM,
  pools,
  regions,
  candidates,
};

writeFileSync(output, JSON.stringify(data, null, 1) + '\n');
console.log(`wrote ${output}: ${candidates.length} candidates, ${Object.keys(regions).length} regions, rejected ${rejected.length} (${rejected.join(', ')})`);
