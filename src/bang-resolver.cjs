'use strict';

const TRACKING_KEYS = /^(utm_.+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|vero_id|vero_conv|oly_anon_id|oly_enc_id|ref_src|ref_url|_hsenc|_hsmi)$/i;

function normalizeCommand(command, caseInsensitive = true) {
  const value = String(command || '').trim();
  return caseInsensitive ? value.toLowerCase() : value;
}

function stripTrackingParameters(input) {
  try {
    const url = new URL(input);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_KEYS.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return input;
  }
}

function resolveSearchQuery(query, settings, engines) {
  const text = String(query || '').trim();
  if (!text) return { kind: 'empty' };
  const engineId = settings.defaultSearchEngine || 'duckduckgo';
  if (engineId === 'custom' && settings.allowSearchRedirects === false) return { kind: 'error', message: 'Custom search URLs are disabled. Enable them in Search & Address Bar settings first.' };
  const engine = (engines || []).find(item => item.id === engineId);
  let template = engine && engine.template;
  if (engineId === 'custom') template = settings.customSearchUrl;
  if (!template || !String(template).includes('{query}')) template = 'https://duckduckgo.com/?q={query}';
  const url = String(template).replace(/\{query\}/g, encodeURIComponent(text));
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Unsupported protocol');
    if (!parsed.hostname || parsed.username || parsed.password) throw new Error('Invalid destination');
    return { kind: 'search', url: parsed.toString(), query: text, engine: engineId };
  } catch {
    return { kind: 'error', message: 'The search engine URL is invalid. Use an HTTP(S) URL containing {query}.' };
  }
}

function resolveInput(rawInput, settings, engines, bangs) {
  const input = String(rawInput || '').trim();
  if (!input) return { kind: 'empty' };

  // A personal shortcut such as !l performs a normal search with the remaining text.
  const customAlias = String(settings.customBangAlias || '').trim();
  const aliasMatch = input.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (settings.enableBangCommands !== false && customAlias && aliasMatch && aliasMatch[1].toLowerCase() === customAlias.toLowerCase()) {
    const query = String(aliasMatch[2] || '').trim();
    return query ? resolveSearchQuery(query, settings, engines) : { kind: 'bang-no-query', command: customAlias, name: 'Lithium search alias', category: 'Custom' };
  }

  const prefix = String(settings.bangPrefix || '!');
  if (settings.enableBangCommands !== false && input.startsWith(prefix)) {
    const match = input.match(/^([^\s]+)(?:\s+([\s\S]*))?$/);
    if (match) {
      const commandRaw = match[1];
      const canonicalRaw = prefix === '!' ? commandRaw : `!${commandRaw.slice(prefix.length)}`;
      const command = normalizeCommand(canonicalRaw, settings.caseInsensitiveBangs !== false);
      const index = bangs && bangs.byCommand;
      const bang = index && (index.get(command) || (!settings.caseInsensitiveBangs && index.get(command.toLowerCase())));
      if (bang) {
        const query = (match[2] || '').trim();
        const encoded = encodeURIComponent(query);
        const urlTemplate = String(bang.u || '');
        if (!query) {
          return { kind: 'bang-no-query', command: bang.t, name: bang.s || bang.t, category: bang.c || 'Other' };
        }
        let url = urlTemplate
          .replace(/\{\{\{s\}\}\}/gi, encoded)
          .replace(/\{\{s\}\}/gi, encoded)
          .replace(/\{query\}/gi, encoded)
          .replace(/%s/g, encoded);
        try {
          const parsed = new URL(url);
          if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname || parsed.username || parsed.password) throw new Error('Unsupported or unsafe destination');
          url = parsed.toString();
          if (settings.stripTrackingParameters) url = stripTrackingParameters(url);
          return { kind: 'bang', url, command: bang.t, name: bang.s || bang.t, domain: bang.d || '', category: bang.c || 'Other', query };
        } catch {
          return { kind: 'error', message: 'This shortcut has an invalid destination URL.' };
        }
      }
      if (settings.bangFallbackToSearch === false) return { kind: 'error', message: `Unknown shortcut: ${commandRaw}. Search commands in the local command library.` };
    }
  }

  // URL-like strings are navigated; other text becomes a search query.
  let candidate = input;
  const looksLikeUrl = !/\s/.test(candidate) && (/^(https?:\/\/|localhost(?::\d+)?(?:\/|$)|127\.0\.0\.1(?::\d+)?(?:\/|$)|\[[0-9a-f:]+\](?::\d+)?(?:\/|$))/i.test(candidate) || (settings.autocompleteDomains !== false && /^[\w-]+(?:\.[\w-]+)+(?:\:\d+)?(?:[/?#].*)?$/i.test(candidate)));
  if (looksLikeUrl) {
    try {
      if (!/^https?:\/\//i.test(candidate)) candidate = `${settings.defaultProtocolHttps === false ? 'http' : 'https'}://${candidate}`;
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Unsupported protocol');
      if (settings.stripTrackingParameters) candidate = stripTrackingParameters(parsed.toString());
      return { kind: 'url', url: candidate };
    } catch {
      // Invalid URL-like text can still be a search query.
    }
  }

  return resolveSearchQuery(input, settings, engines);
}

function isSafeBangTemplate(template) {
  if (typeof template !== 'string' || !template || template.length > 4096) return false;
  const hasQueryToken = /(\{\{\{s\}\}\}|\{\{s\}\}|\{query\}|%s)/i.test(template);
  const probe = template.replace(/\{\{\{s\}\}\}|\{\{s\}\}|\{query\}|%s/gi, 'lithium-test');
  try {
    const parsed = new URL(probe);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && Boolean(parsed.hostname) && !parsed.username && !parsed.password && (hasQueryToken || parsed.pathname !== '' || parsed.search !== '' || parsed.hash !== '');
  } catch {
    return false;
  }
}

function buildBangIndex(items) {
  const byCommand = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.t !== 'string' || typeof item.u !== 'string') continue;
    const command = item.t.trim();
    if (!/^![^\s!]+$/.test(command) || !isSafeBangTemplate(item.u)) continue;
    const key = command.toLowerCase();
    if (!byCommand.has(key)) byCommand.set(key, { ...item, t: command });
  }
  return { byCommand, items: [...byCommand.values()] };
}

function searchBangs(index, query, limit = 12) {
  const needle = String(query || '').toLowerCase().trim();
  if (!needle) return index.items.slice(0, Math.min(limit, 50));
  const parts = needle.split(/\s+/);
  return index.items
    .filter(item => {
      const t = String(item.t || '').toLowerCase();
      const s = String(item.s || '').toLowerCase();
      const d = String(item.d || '').toLowerCase();
      return t.includes(parts[0]) || s.includes(needle) || d.includes(needle);
    })
    .sort((a, b) => {
      const at = String(a.t || '').toLowerCase();
      const bt = String(b.t || '').toLowerCase();
      const ae = at === needle ? 0 : at.startsWith(needle) ? 1 : 2;
      const be = bt === needle ? 0 : bt.startsWith(needle) ? 1 : 2;
      return ae - be || at.localeCompare(bt);
    })
    .slice(0, Math.min(limit, 50));
}

module.exports = { buildBangIndex, isSafeBangTemplate, normalizeCommand, resolveInput, resolveSearchQuery, searchBangs, stripTrackingParameters };
