'use strict';

const { safeHttpUrl } = require('./url-policy.cjs');
const QUERY_TOKEN = /\{\{\{s\}\}\}|\{\{s\}\}|\{query\}|%s/i;

/**
 * Validate one user-defined search command. Commands are data only: destination
 * templates must resolve to HTTP(S), contain a recognized query placeholder,
 * and may not embed URL credentials.
 */
function normalizeCustomBang(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const command = String(row.t || row.command || '').trim();
  const name = String(row.s || row.name || command).trim().slice(0, 160);
  const domain = String(row.d || row.domain || '').trim().slice(0, 200);
  const template = String(row.u || row.url || '').trim();
  if (!/^![^\s!]+$/.test(command) || !name || !template || template.length > 2048) return null;
  if (!QUERY_TOKEN.test(template)) return null;
  const probe = template.replace(/\{\{\{s\}\}\}|\{\{s\}\}|\{query\}|%s/gi, 'lithium-test');
  if (!safeHttpUrl(probe)) return null;
  return {
    t: command,
    s: name,
    d: domain,
    u: template,
    c: String(row.c || row.category || 'Custom').trim().slice(0, 80) || 'Custom',
    custom: true,
  };
}

function normalizeCustomBangList(rows, max = 5000) {
  if (!Array.isArray(rows)) return [];
  const byKey = new Map();
  for (const row of rows.slice(0, Math.max(max * 2, max))) {
    const item = normalizeCustomBang(row);
    if (item) byKey.set(item.t.toLowerCase(), item);
  }
  return [...byKey.values()].slice(0, max);
}

module.exports = { normalizeCustomBang, normalizeCustomBangList };
