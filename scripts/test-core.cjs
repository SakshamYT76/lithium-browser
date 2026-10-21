'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { buildBangIndex, isSafeBangTemplate, resolveInput, searchBangs, stripTrackingParameters } = require('../src/bang-resolver.cjs');
const { normalizeCustomBang, normalizeCustomBangList } = require('../src/custom-bangs.cjs');
const { safeHttpUrl } = require('../src/url-policy.cjs');
const bangs = buildBangIndex([
  { t: '!yt', s: 'YouTube', d: 'youtube.com', u: 'https://www.youtube.com/results?search_query={{{s}}}', c: 'Multimedia' },
  { t: '!ytc', s: 'YouTube Channels', d: 'youtube.com', u: 'https://www.youtube.com/results?search_query={{{s}}}&sp=EgIQAg%3D%3D', c: 'Multimedia' },
]);
const engines = [{ id: 'duckduckgo', template: 'https://duckduckgo.com/?q={query}' }];
const settings = { defaultSearchEngine: 'duckduckgo', enableBangCommands: true, bangPrefix: '!', caseInsensitiveBangs: true, stripTrackingParameters: true, defaultProtocolHttps: true };
let result = resolveInput('!ytc TechnOGamerz', settings, engines, bangs);
assert.equal(result.kind, 'bang');
assert.match(result.url, /TechnOGamerz/);
assert.equal(resolveInput('example.com', settings, engines, bangs).kind, 'url');
assert.equal(resolveInput('hello world', settings, engines, bangs).kind, 'search');
assert.equal(searchBangs(bangs, '!yt', 5).length, 2);
const aliased = resolveInput('!l lithium browser', { ...settings, customBangAlias: '!l' }, engines, bangs);
assert.equal(aliased.kind, 'search', 'Personal !l alias should perform a default search.');
assert.match(aliased.url, /lithium%20browser/);
assert.equal(resolveInput('!l', { ...settings, customBangAlias: '!l' }, engines, bangs).kind, 'bang-no-query');
const custom = buildBangIndex([{ t: '!docs', s: 'Docs', d: 'docs.example', u: 'https://docs.example/search?q={query}', c: 'Custom', custom: true }]);
assert.equal(resolveInput('!docs hello', settings, engines, custom).kind, 'bang');
assert.match(resolveInput('!docs hello', settings, engines, custom).url, /q=hello/);
assert.equal(stripTrackingParameters('https://example.com/?q=x&utm_source=test&fbclid=abc'), 'https://example.com/?q=x');
assert.equal(isSafeBangTemplate('https://example.com/search?q={{{s}}}'), true);
assert.equal(isSafeBangTemplate('javascript:alert(1)'), false);
assert.equal(isSafeBangTemplate('https://user:pass@example.com/search?q={{{s}}}'), false);
assert.equal(buildBangIndex([{ t: '!evil', u: 'https://user:pass@example.com/?q={{{s}}}' }]).items.length, 0, 'Bang index must reject URL credentials.');
assert.equal(buildBangIndex([{ t: '!bad', u: 'javascript:alert(1)' }]).items.length, 0, 'Bang index must reject non-web protocols.');
const validCustom = normalizeCustomBang({ command: '!docs', name: 'Documentation', url: 'https://docs.example/search?q={query}' });
assert.equal(validCustom.t, '!docs');
assert.equal(normalizeCustomBang({ command: '!bad', url: 'javascript:alert(1)' }), null, 'Custom commands must reject script URLs.');
assert.equal(normalizeCustomBang({ command: '!bad', url: 'https://user:pass@example.com/?q={query}' }), null, 'Custom commands must reject embedded URL credentials.');
assert.equal(normalizeCustomBang({ command: 'bad command', url: 'https://example.com/?q={query}' }), null, 'Custom command keys may not include spaces.');
assert.equal(normalizeCustomBangList([validCustom, validCustom, { command: '!invalid', url: 'file:///tmp/?q={query}' }]).length, 1, 'Custom command imports should validate and de-duplicate entries.');
// Project integrity checks: guard against shipping a tiny list while advertising a large library.
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'settings-catalog.json'), 'utf8'));
assert.ok(catalog.length >= 150, 'Expected the full settings catalog to contain at least 150 entries.');
assert.ok(catalog.filter(item => item.status === 'available').length >= 100, 'At least 100 preferences should be implemented in the first source milestone.');
assert.equal(new Set(catalog.map(item => item.id)).size, catalog.length, 'Setting ids must be unique.');
for (const item of catalog) {
  assert.ok(item.id && item.category && item.label && item.description, 'Every setting needs metadata.');
  assert.ok(['available', 'planned'].includes(item.status), `Invalid status for ${item.id}`);
}
const searchEngines = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'search-engines.json'), 'utf8'));
assert.ok(searchEngines.filter(item => item.id !== 'custom').length >= 6, 'Expected at least six selectable built-in search engines.');
for (const engine of searchEngines.filter(item => item.id !== 'custom')) {
  assert.ok(engine.template.includes('{query}'), `Missing query token in ${engine.id}`);
  assert.equal(new URL(engine.template.replace('{query}', 'lithium%20browser')).protocol, 'https:', `${engine.id} must use HTTPS.`);
}
assert.ok(fs.existsSync(path.join(root, '.github', 'workflows', 'build-windows.yml')), 'Windows build workflow is missing.');
assert.ok(fs.existsSync(path.join(root, 'assets', 'lithium.ico')), 'Windows icon is missing.');
const mainSource = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
assert.match(mainSource, /contentView\.addChildView\(view\)/, 'WebContentsView must be attached to BrowserWindow or web pages will not paint.');
assert.match(mainSource, /contentView\.removeChildView\(tab\.view\)/, 'Closing tabs must remove their native child views.');
assert.match(mainSource, /item\.setSaveDialogOptions\(/, 'Ask-where-to-save must use Electron’s download save-dialog API.');
assert.match(mainSource, /state\.settings\.httpsOnlyMode[\s\S]*resourceType === 'mainFrame'/, 'HTTPS-only must upgrade top-level HTTP navigation.');
assert.match(mainSource, /commands:add-custom/, 'Custom search shortcuts must be persisted by IPC.');
assert.match(mainSource, /The settings file must contain a JSON object/, 'Malformed settings imports should be handled gracefully.');
assert.match(mainSource, /No valid custom shortcuts were found\. Existing commands were kept\./, 'Invalid shortcut imports must not wipe saved commands.');
assert.match(mainSource, /isSafeBangTemplate\(item\.u\)/, 'Refreshed bang entries must validate their destination templates.');
assert.match(mainSource, /contentView\.removeChildView\(tab\.view\)/, 'Closed tabs must detach their native view.');
assert.equal(safeHttpUrl('https://user:pass@example.com'), null, 'Navigation policy must reject embedded URL credentials.');
assert.equal(safeHttpUrl('javascript:alert(1)'), null, 'Navigation policy must reject script URLs.');
assert.equal(safeHttpUrl('https://example.com/path'), 'https://example.com/path', 'Navigation policy should accept regular HTTPS addresses.');
console.log(`Lithium checks passed: URL policy, custom command validation/import, ${catalog.length} settings (${catalog.filter(item => item.status === 'available').length} available), ${searchEngines.filter(item => item.id !== 'custom').length} built-in search engines, bang resolution, native browser-view wiring, safe import/download handling, and Windows package scaffolding.`);
