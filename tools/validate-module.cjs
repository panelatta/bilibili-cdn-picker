'use strict';

// Checks the configuration constructs emitted by this project, not a complete
// replacement for Surge's parser. Run on both local and remote artifacts.
function fields(text) {
  const parts = [];
  let quoted = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' && text[i - 1] !== '\\') quoted = !quoted;
    if (text[i] === ',' && !quoted) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  if (quoted) throw new Error('Unclosed quote in module declaration');
  parts.push(text.slice(start));
  const result = Object.create(null);
  for (const part of parts) {
    const m = /^\s*([a-z][a-z-]*)\s*=\s*(.*?)\s*$/.exec(part);
    if (!m || !m[2] || Object.hasOwn(result, m[1])) throw new Error('Malformed or duplicate field: ' + part);
    result[m[1]] = m[2].startsWith('"') && m[2].endsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return result;
}

function validateModule(text, { remote = false } = {}) {
  if (/@@[A-Z_]+@@/.test(text)) throw new Error('Unexpanded build placeholder');
  const headers = [...text.matchAll(/^#!arguments=(.*)$/gm)];
  if (headers.length > 1) throw new Error('Expected at most one arguments header');
  const defaults = Object.create(null);
  for (const entry of headers.length ? headers[0][1].split(',') : []) {
    const m = /^([A-Za-z0-9_]+)(?::(.+))?$/.exec(entry.trim());
    if (!m || (m[2] !== undefined && !m[2].trim())) throw new Error('Malformed argument declaration: ' + entry);
    if (Object.hasOwn(defaults, m[1])) throw new Error('Duplicate argument: ' + m[1]);
    defaults[m[1]] = m[2] === undefined ? '' : m[2];
  }
  const used = new Set([...text.matchAll(/\{\{\{([A-Za-z0-9_]+)\}\}\}/g)].map((m) => m[1]));
  for (const key of used) if (!Object.hasOwn(defaults, key)) throw new Error('Undeclared argument: ' + key);
  for (const key of Object.keys(defaults)) if (!used.has(key)) throw new Error('Unused argument: ' + key);
  const scripts = Object.create(null), panels = Object.create(null);
  let section = '';
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) { section = sectionMatch[1]; continue; }
    if (section !== 'Script' && section !== 'Panel') continue;
    const m = /^([^=]+?)\s*=\s*(.+)$/.exec(line);
    if (!m) throw new Error('Malformed ' + section + ' declaration');
    const target = section === 'Script' ? scripts : panels;
    if (Object.hasOwn(target, m[1])) throw new Error('Duplicate declaration: ' + m[1]);
    const f = target[m[1]] = fields(m[2]);
    if (section === 'Script') {
      if (!['http-request', 'http-response', 'cron', 'generic', 'event'].includes(f.type)) throw new Error('Unsupported script type');
      if (!f['script-path']) throw new Error('Missing script-path');
      if (remote) {
        const u = new URL(f['script-path']);
        if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || /\s/.test(f['script-path'])) {
          throw new Error('Invalid remote script-path');
        }
      }
      if (f.type.startsWith('http-')) {
        if (!f.pattern) throw new Error('Missing HTTP pattern');
        new RegExp(f.pattern);
      }
      if (f.engine && !['jsc', 'webview', 'auto'].includes(f.engine)) throw new Error('Invalid engine');
      if (f.debug && !['true', 'false'].includes(f.debug) && !/^\{\{\{[A-Za-z0-9_]+\}\}\}$/.test(f.debug)) throw new Error('Invalid debug');
      if (f.timeout && !(Number(f.timeout) > 0)) throw new Error('Invalid timeout');
      if (f['requires-body'] && !['true', 'false'].includes(f['requires-body'])) throw new Error('Invalid requires-body');
      if (f.type === 'cron' && (!f.cronexp || ![5, 6].includes(f.cronexp.split(/\s+/).length))) throw new Error('Invalid cronexp');
      if (f.type === 'event' && !['network-changed', 'notification', 'engine-started', 'profile-reloaded'].includes(f['event-name'])) throw new Error('Invalid event-name');
    }
  }
  if (!Object.keys(scripts).length) throw new Error('Missing scripts');
  for (const f of Object.values(panels)) {
    if (f['script-name'] && (!scripts[f['script-name']] || scripts[f['script-name']].type !== 'generic')) throw new Error('Panel must reference a generic script');
    if (f.style && !['good', 'info', 'alert', 'error'].includes(f.style)) throw new Error('Invalid panel style');
    if (f['update-interval'] && !(Number(f['update-interval']) > 0)) throw new Error('Invalid panel interval');
  }
  return { defaults, scripts, panels };
}

module.exports = { validateModule };
