import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const target = path.join(root, 'resources', 'bangs.json');
const source = 'https://duckduckgo.com/bang.js';

function normalize(row) {
  if (!row || typeof row.t !== 'string' || typeof row.u !== 'string') return null;
  const command = row.t.trim();
  const template = row.u.trim();
  if (!/^![^\s!]+$/.test(command) || template.length > 4096) return null;
  const probe = template.replace(/\{\{\{s\}\}\}|\{\{s\}\}|\{query\}|%s/gi, 'lithium-test');
  try {
    const url = new URL(probe);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
  } catch { return null; }
  return { t: command, s: String(row.s || command).slice(0, 300), d: String(row.d || '').slice(0, 300), u: template, c: String(row.c || 'Other').slice(0, 100) };
}

try {
  const response = await fetch(source, { headers: { 'User-Agent': 'LithiumBrowser-BangLibrary/0.1 (+source-build)' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('The bang source returned an unexpected format.');
  const unique = new Map();
  for (const row of rows) {
    const item = normalize(row);
    if (item && !unique.has(item.t.toLowerCase())) unique.set(item.t.toLowerCase(), item);
  }
  if (unique.size < 3000) throw new Error(`Only ${unique.size} valid commands were received; refusing to package a misleadingly small library.`);
  await fs.writeFile(target, JSON.stringify([...unique.values()], null, 2), 'utf8');
  console.log(`Fetched ${unique.size.toLocaleString()} valid search shortcuts from ${source}.`);
} catch (error) {
  console.error(`Bang-library download failed: ${error.message}`);
  console.error('The release workflow should stop instead of claiming that the full library was included.');
  process.exitCode = 1;
}
