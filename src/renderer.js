'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const formatDate = value => {
    try { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; }
  };
  const formatBytes = value => {
    const n = Number(value) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };
  const symbolFor = value => {
    const str = String(value || '').trim();
    return str.startsWith('!') ? '!' : str.slice(0, 1).toUpperCase() || 'L';
  };

  let snapshot = { tabs: [], activeTabId: null, settings: {}, bookmarks: [], bangCount: 0, version: '0.2.0' };
  let catalog = [];
  let appInfo = {};
  let currentPageToken = '';
  let currentSettingsCategory = 'General';
  let settingsSearch = '';
  let commandsSearch = '';
  let commandsCategory = '';
  let commandsLimit = 200;
  let suggestions = [];
  let selectedSuggestion = -1;
  let suggestionTimer = null;
  let toastTimer = null;
  let menuOpen = false;
  let addressWasFocused = false;
  let maximized = false;

  const root = $('#app-root');
  const stage = $('#browser-stage');
  const pageContent = $('#page-content');
  const address = $('#address-bar');
  const suggestionsBox = $('#address-suggestions');
  const statusMessage = $('#status-message');
  const statusDot = $('#status-dot');
  const stageToast = $('#stage-toast');
  const menu = $('#app-menu');

  function activeTab() { return snapshot.tabs.find(tab => tab.id === snapshot.activeTabId) || snapshot.tabs[0] || null; }
  function setting(key, fallback) { return snapshot.settings && snapshot.settings[key] !== undefined ? snapshot.settings[key] : fallback; }
  function currentRoute() { const tab = activeTab(); return tab?.route || null; }
  function isCurrentInternal() { return Boolean(currentRoute()); }
  function currentUrl() { const tab = activeTab(); return tab ? tab.url || '' : ''; }
  function isBookmarked(url) { return (snapshot.bookmarks || []).some(item => item.url === url); }
  function getEngineLabel(id) {
    const engine = (catalog._engines || []).find(item => item.id === id);
    return engine ? engine.name : ({ duckduckgo: 'DuckDuckGo', google: 'Google', brave: 'Brave Search' }[id] || id || 'DuckDuckGo');
  }

  function toast(message, kind = 'normal') {
    stageToast.textContent = message;
    stageToast.classList.remove('hidden');
    stageToast.dataset.kind = kind;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => stageToast.classList.add('hidden'), 3200);
    statusMessage.textContent = message;
  }

  function applyAppearance() {
    const s = snapshot.settings || {};
    let theme = s.theme || 'dark';
    if (theme === 'system') theme = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    root.dataset.theme = theme;
    root.dataset.accent = s.accentColor || 'violet';
    if (/^#[0-9a-f]{6}$/i.test(String(s.customAccentHex || ''))) {
      root.style.setProperty('--accent', s.customAccentHex);
      root.style.setProperty('--accent-soft', `color-mix(in srgb, ${s.customAccentHex} 14%, transparent)`);
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-soft');
    }
    root.dataset.density = s.density || 'comfortable';
    root.dataset.tabPosition = s.tabPosition || 'top';
    root.dataset.tabShape = s.tabShape || 'rounded';
    root.dataset.toolbarLayout = s.toolbarLayout || 'standard';
    root.dataset.showBookmarks = String(s.showBookmarksBar !== false);
    root.dataset.showStatus = String(s.showStatusBar !== false);
    root.dataset.showSidebar = String(s.showSidebar === true);
    root.dataset.showHome = String(s.showHomeButton !== false);
    root.dataset.showDownloads = String(s.showDownloadsButton !== false);
    root.dataset.showShield = String(s.showShieldButton !== false);
    root.dataset.showBookmark = String(s.showBookmarkButton !== false);
    root.dataset.showMenu = String(s.showAppMenuButton !== false);
    root.dataset.showLoading = String(s.showPageLoadingProgress !== false);
    root.dataset.hideTitle = String(s.hideWindowTitleText === true);
    root.dataset.compactLabels = String(s.compactTabLabels === true);
    root.dataset.blurEffects = String(s.blurEffects === true);
    root.dataset.smoothScrolling = String(s.smoothScrolling !== false);
    root.dataset.tooltips = String(s.tooltips !== false);
    root.dataset.sidebarPosition = s.sidebarPosition || 'left';
    root.dataset.fontScale = s.uiFontScale || 'normal';
    root.dataset.uiFont = s.uiFont || 'system';
    root.dataset.corners = s.cornerRadius || 'medium';
    root.classList.toggle('no-motion', s.animations === false || s.reducedMotion === true);
    root.classList.toggle('high-contrast', s.highContrastUi === true || s.highContrast === true);
    root.classList.toggle('large-text', s.largerText === true);
    root.classList.toggle('no-focus-ring', s.focusOutlines === false || s.keyboardFocusRing === false);
    $('#page-content').setAttribute('aria-live', s.statusAnnouncements === false ? 'off' : 'polite');
    const tooltipScopes = [$('#toolbar'), $('#titlebar'), $('#tab-strip')];
    for (const scope of tooltipScopes) for (const el of scope.querySelectorAll('[title], [data-lithium-title]')) {
      if (el.title && !el.dataset.lithiumTitle) el.dataset.lithiumTitle = el.title;
      if (el.dataset.lithiumTitle) el.title = s.tooltips === false ? '' : el.dataset.lithiumTitle;
    }
    const resetAction = $('[data-action="reset-settings"]');
    if (resetAction) resetAction.classList.toggle('hidden', s.resetSettingsButton === false);
    $('#sidebar').classList.toggle('hidden', s.showSidebar !== true);
    $('#nav-home').classList.toggle('hidden', s.showHomeButton === false);
    $('#nav-downloads').classList.toggle('hidden', s.showDownloadsButton === false);
    $('#nav-shield').classList.toggle('hidden', s.showShieldButton === false);
    $('#nav-bookmark').classList.toggle('hidden', s.showBookmarkButton === false);
    $('#app-menu-button').classList.toggle('hidden', s.showAppMenuButton === false);
    $('#bookmarks-bar').classList.toggle('hidden', s.showBookmarksBar === false);
    $('#statusbar').classList.toggle('hidden', s.showStatusBar === false);
    $('#engine-indicator').classList.toggle('hidden', s.showSearchEngineIndicator === false);
    if (s.customWallpaperUrl) {
      const safe = String(s.customWallpaperUrl).replace(/["\\()\s]/g, char => encodeURIComponent(char));
      document.documentElement.style.setProperty('--wallpaper-url', `url("${safe}")`);
    } else document.documentElement.style.removeProperty('--wallpaper-url');
    updateAddressBar();
    renderBookmarksBar();
    updateSettingControlValues();
    updateStageBounds();
  }

  function updateAddressBar() {
    const tab = activeTab();
    if (!tab) { address.value = ''; return; }
    if (document.activeElement === address && addressWasFocused) return;
    let url = tab.route ? '' : (tab.url || '');
    if (setting('showUrlProtocol', false) === false && !document.activeElement?.isSameNode(address) && /^https?:\/\//i.test(url)) url = url.replace(/^https?:\/\//i, '');
    address.value = url;
    $('#nav-back').disabled = !tab.canGoBack;
    $('#nav-forward').disabled = !tab.canGoForward;
    $('#nav-reload').disabled = !tab.url || Boolean(tab.route);
    $('#nav-bookmark').classList.toggle('selected', isBookmarked(tab.url));
    const engine = setting('defaultSearchEngine', 'duckduckgo');
    $('#engine-indicator').textContent = ({ duckduckgo: 'DDG', google: 'GO', brave: 'BR', startpage: 'SP', bing: 'BI', ecosia: 'EC', qwant: 'QW', mojeek: 'MJ', custom: 'CUSTOM' })[engine] || 'SEARCH';
    $('#engine-indicator').title = `${getEngineLabel(engine)} is the default search engine`;
  }

  function updateStageBounds() {
    const tab = activeTab();
    if (!tab) return;
    requestAnimationFrame(() => {
      const rect = stage.getBoundingClientRect();
      window.lithium.setViewLayout(tab.id, { x: rect.left, y: rect.top, width: rect.width, height: rect.height }).catch(() => {});
      window.lithium.setViewMode(tab.id, tab.route ? 'internal' : 'web').catch(() => {});
    });
  }

  function renderTabs() {
    const tabs = snapshot.tabs || [];
    const tabStrip = $('#tab-strip');
    tabStrip.innerHTML = tabs.map(tab => {
      const isActive = tab.id === snapshot.activeTabId;
      const label = tab.title || (tab.route === 'newtab' ? 'New tab' : 'Untitled');
      const ariaLabel = setting('accessibleTabLabels', false) ? `Tab: ${label}${isActive ? ', active' : ''}` : label;
      const closeButton = setting('showTabCloseButtons', true) ? `<span class="tab-close" data-close-tab="${escapeHtml(tab.id)}" title="Close tab" aria-label="Close tab">×</span>` : '';
      const favicon = setting('showTabFavicons', true) ? `<span class="tab-favicon">${escapeHtml(symbolFor(label))}</span>` : '';
      return `<button class="tab ${isActive ? 'active' : ''}" role="tab" aria-label="${escapeHtml(ariaLabel)}" aria-selected="${isActive}" data-tab-id="${escapeHtml(tab.id)}" title="${escapeHtml(label)}">
        ${favicon}
        ${tab.loading && setting('showPageLoadingProgress', true) ? '<span class="tab-loading"></span>' : ''}
        <span class="tab-title">${escapeHtml(label)}</span>
        ${closeButton}
      </button>`;
    }).join('') + (setting('showNewTabButton', true) ? '<button id="new-tab-button" class="new-tab-button" title="New tab (Ctrl+T)" aria-label="New tab">+</button>' : '');
    $('#status-tab-count')?.remove();
    if (setting('showTabCount', false)) {
      const count = document.createElement('span'); count.id = 'status-tab-count'; count.className = 'inline-badge'; count.textContent = `${tabs.length} tabs`; tabStrip.appendChild(count);
    }
    const active = activeTab();
    $('#status-dot').classList.toggle('loading', Boolean(active?.loading));
    if (active?.loading) $('#status-message').textContent = 'Loading page…';
    else if (!isCurrentInternal()) $('#status-message').textContent = 'Protected locally · no account · no telemetry';
    else $('#status-message').textContent = `Lithium ${active?.route === 'newtab' ? 'ready' : active?.title || 'ready'} · preferences stored locally`;
    $('#bang-count').textContent = `${Number(snapshot.bangCount || 0).toLocaleString()} local commands`;
    $('#status-engine').textContent = getEngineLabel(setting('defaultSearchEngine', 'duckduckgo'));
    $('#status-version').textContent = `v${snapshot.version || appInfo.version || '0.2.0'}`;
    $('#brand-version').textContent = `PREVIEW ${appInfo.version || snapshot.version || '0.2.0'}`;
    updateAddressBar();
  }

  function renderBookmarksBar() {
    const target = $('#bookmarks-bar');
    const items = snapshot.bookmarks || [];
    if (setting('showBookmarksBar', true) === false) { target.classList.add('hidden'); target.innerHTML = ''; return; }
    target.classList.remove('hidden');
    const visible = items.slice(0, 9);
    target.innerHTML = `${visible.map(item => `<button class="bookmark-chip" data-open-url="${escapeHtml(item.url)}" title="${escapeHtml(item.url)}"><span class="quick-icon" style="width:17px;height:17px;border-radius:5px;font-size:8px">${escapeHtml(symbolFor(item.title))}</span><span>${escapeHtml(item.title || item.url)}</span></button>`).join('')}${items.length > 9 ? `<button class="bookmark-chip" data-route="bookmarks">+${items.length - 9} more</button>` : ''}${!items.length ? '<span class="bookmarks-empty">Bookmarks you add will appear here</span>' : ''}<button class="bookmark-chip" data-route="bookmarks" title="All bookmarks">All bookmarks ↗</button>`;
  }

  function logoSvg() { return '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15.5"/><ellipse cx="20" cy="20" rx="6.6" ry="15.5"/><ellipse cx="20" cy="20" rx="15.5" ry="6.6"/><circle class="logo-core" cx="20" cy="20" r="3.1"/></svg>'; }
  function startPage() {
    const layout = setting('newTabLayout', 'centered');
    const bg = setting('newTabBackground', 'gradient');
    const clock = setting('showNewTabClock', true) ? `<span class="start-clock" id="local-clock">${escapeHtml(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>` : '<span></span>';
    const quick = setting('showQuickLinks', true) ? `<div class="quick-grid">
      <button class="quick-link" data-url="https://duckduckgo.com"><span class="quick-icon">D</span><span>DuckDuckGo</span></button>
      <button class="quick-link" data-url="https://www.youtube.com"><span class="quick-icon">▶</span><span>YouTube</span></button>
      <button class="quick-link" data-url="https://github.com"><span class="quick-icon">⌘</span><span>GitHub</span></button>
      <button class="quick-link" data-route="commands"><span class="quick-icon">!</span><span>Search commands</span></button>
      <button class="quick-link" data-route="bookmarks"><span class="quick-icon">✧</span><span>Bookmarks</span></button>
      <button class="quick-link" data-route="history"><span class="quick-icon">◷</span><span>History</span></button>
      <button class="quick-link" data-route="downloads"><span class="quick-icon">↓</span><span>Downloads</span></button>
      <button class="quick-link" data-route="settings"><span class="quick-icon">⚙</span><span>Settings</span></button>
    </div>` : '';
    const search = setting('showSearchCard', true) ? `<form class="start-search" id="start-search-form"><span class="start-search-icon">⌕</span><input id="start-search-input" placeholder="Search or use a command like !ytc TechnOGamerz" autocomplete="off" spellcheck="false"/><button type="submit" aria-label="Search">↵</button></form>` : '';
    return `<section class="start-page" data-background="${escapeHtml(bg)}" data-layout="${escapeHtml(layout)}">
      <div class="start-topline"><span>YOUR SPACE, YOUR RULES</span>${clock}</div>
      <div class="start-hero"><div class="start-logo">${logoSvg()}</div><div class="start-title">Lithium</div><div class="start-tagline">A quieter place to browse.</div>${search}${quick}</div>
      <div class="start-bottom">No Lithium account · No product telemetry · Settings stay on this device</div>
    </section>`;
  }

  function settingsNav() {
    const categories = [...new Set(catalog.map(item => item.category))];
    return categories.map((name, index) => {
      const count = catalog.filter(item => item.category === name).length;
      const mark = ['◈', '⌕', '✧', '⬡', '▤', '↓', 'ϟ', '◉', '⌘'][index % 9];
      return `<button class="${name === currentSettingsCategory ? 'active' : ''}" data-settings-category="${escapeHtml(name)}"><span>${mark}</span><span>${escapeHtml(name)}</span><span class="nav-count">${count}</span></button>`;
    }).join('');
  }

  function settingControl(item) {
    const val = setting(item.id, item.default);
    const disabled = item.status !== 'available';
    const attrs = `data-setting="${escapeHtml(item.id)}" ${disabled ? 'disabled' : ''} title="${disabled ? 'Planned for a future release' : escapeHtml(item.description)}"`;
    if (item.type === 'toggle') return `<label class="toggle-control"><input type="checkbox" ${attrs} ${val === true ? 'checked' : ''}><span class="toggle-track"></span></label>`;
    if (item.type === 'select') return `<div class="setting-control"><select ${attrs}>${(item.options || []).map(option => `<option value="${escapeHtml(option[0])}" ${String(option[0]) === String(val) ? 'selected' : ''}>${escapeHtml(option[1])}</option>`).join('')}</select></div>`;
    if (item.type === 'number') return `<div class="setting-control"><input type="number" ${attrs} value="${escapeHtml(val)}" min="${item.id === 'pageZoom' ? 50 : item.id === 'maxAddressSuggestions' ? 3 : 0}" max="${item.id === 'pageZoom' ? 200 : item.id === 'maxAddressSuggestions' ? 20 : 100}" step="1"></div>`;
    return `<div class="setting-control"><input type="text" ${attrs} value="${escapeHtml(val)}" placeholder="${item.id === 'customSearchUrl' ? 'https://example.com/search?q={query}' : item.id === 'downloadDirectory' ? 'System Downloads folder' : ''}" maxlength="4096"></div>`;
  }

  function settingRow(item) {
    const disabled = item.status !== 'available';
    const restart = item.restartRequired ? '<span class="setting-status restart">Restart</span>' : '';
    const planned = disabled ? '<span class="setting-status">Planned</span>' : '';
    return `<div class="setting-row ${disabled ? 'disabled' : ''}"><div class="setting-copy"><div class="setting-name">${escapeHtml(item.label)} ${restart}${planned}</div><div class="setting-description">${escapeHtml(item.description)}</div></div>${settingControl(item)}</div>`;
  }

  function renderSettings() {
    const available = catalog.filter(item => item.status === 'available').length;
    const planned = catalog.length - available;
    const match = item => !settingsSearch || `${item.label} ${item.description} ${item.category} ${item.id}`.toLowerCase().includes(settingsSearch.toLowerCase());
    let groups;
    if (settingsSearch) {
      groups = [...new Set(catalog.filter(match).map(item => item.category))].map(category => [category, catalog.filter(item => item.category === category && match(item))]);
    } else groups = [[currentSettingsCategory, catalog.filter(item => item.category === currentSettingsCategory)]];
    const body = groups.map(([category, items]) => `<section class="settings-group"><h3 class="settings-group-title">${escapeHtml(category)}</h3>${items.map(settingRow).join('')}</section>`).join('') || '<div class="empty-state">No settings matched your search.</div>';
    pageContent.innerHTML = `<div class="page-wrap">
      <div class="page-heading"><div><div class="page-eyebrow">LITHIUM CONTROL CENTER</div><h1 class="page-title">Settings</h1><div class="page-description">Tune the browser to your workflow. Available settings apply immediately where possible; features not implemented in this build are clearly marked instead of pretending to work.</div></div><div class="page-actions"><button class="button-secondary" data-action="export-settings">Export</button><button class="button-secondary" data-action="import-settings">Import</button>${setting('resetSettingsButton', true) ? '<button class="button-secondary" data-action="reset-settings">Reset</button>' : ''}</div></div>
      <div class="banner"><span>◈</span><div><strong>${available} available · ${planned} planned</strong><br>Preferences are stored locally. Lithium does not include an account system or product telemetry. A few engine-level controls require a restart.</div></div>
      <div class="settings-layout"><nav class="settings-nav">${settingsNav()}</nav><div class="settings-main"><label class="settings-search"><span>⌕</span><input id="settings-search-input" value="${escapeHtml(settingsSearch)}" placeholder="Search all ${catalog.length} settings…"><span class="inline-badge">${catalog.length} options</span></label>${body}</div></div>
    </div>`;
  }

  function renderHistory() {
    const list = window.__lithiumHistory || [];
    const items = list.length ? list.map(item => `<div class="data-item"><span class="quick-icon">◷</span><div class="data-item-main"><span class="data-item-title">${escapeHtml(item.title || item.url)}</span><span class="data-item-sub">${escapeHtml(item.url)} · ${escapeHtml(formatDate(item.visitedAt))}</span></div><div class="data-item-actions"><button class="button-secondary" data-open-url="${escapeHtml(item.url)}">Open</button><button class="button-secondary" data-copy-url="${escapeHtml(item.url)}">Copy URL</button></div></div>`).join('') : '<div class="empty-state">No saved history. Browse pages with local history enabled and they will appear here.</div>';
    pageContent.innerHTML = `<div class="page-wrap"><div class="page-heading"><div><div class="page-eyebrow">ON THIS DEVICE</div><h1 class="page-title">History</h1><div class="page-description">Browsing history is stored locally when enabled. Lithium does not send it to a Lithium account.</div></div><div class="page-actions"><button class="button-danger" data-action="clear-history">Clear history</button></div></div><div class="data-table">${items}</div></div>`;
  }

  function renderBookmarks() {
    const list = snapshot.bookmarks || [];
    const items = list.length ? list.map(item => `<div class="data-item"><span class="quick-icon">✧</span><div class="data-item-main"><span class="data-item-title">${escapeHtml(item.title || item.url)}</span><span class="data-item-sub">${escapeHtml(item.url)}</span></div><div class="data-item-actions"><button class="button-secondary" data-open-url="${escapeHtml(item.url)}">Open</button><button class="button-secondary" data-remove-bookmark="${escapeHtml(item.id)}">Remove</button></div></div>`).join('') : '<div class="empty-state">No bookmarks yet. Click the star beside the address bar while viewing a website.</div>';
    pageContent.innerHTML = `<div class="page-wrap"><div class="page-heading"><div><div class="page-eyebrow">YOUR SAVED PAGES</div><h1 class="page-title">Bookmarks</h1><div class="page-description">Bookmarks are stored locally and can be included in a settings export.</div></div></div><div class="data-table">${items}</div></div>`;
  }

  async function renderDownloads() {
    let list = [];
    try { list = await window.lithium.getDownloads(); } catch {}
    const items = list.length ? list.map(item => `<div class="data-item"><span class="quick-icon">↓</span><div class="data-item-main"><span class="data-item-title">${escapeHtml(item.filename)}</span><span class="data-item-sub">${escapeHtml(item.state)}${setting('showDownloadFileSizes', true) ? ` · ${escapeHtml(formatBytes(item.receivedBytes))}${item.totalBytes ? ` / ${escapeHtml(formatBytes(item.totalBytes))}` : ''}` : ''} · ${escapeHtml(formatDate(item.finishedAt || item.startedAt))}</span><span class="data-item-sub">${escapeHtml(item.path || '')}</span></div><span class="inline-badge">${escapeHtml(item.state)}</span></div>`).join('') : '<div class="empty-state">No downloads yet. Downloaded files are saved in your configured folder.</div>';
    if (currentRoute() !== 'downloads') return;
    pageContent.innerHTML = `<div class="page-wrap"><div class="page-heading"><div><div class="page-eyebrow">FILE ACTIVITY</div><h1 class="page-title">Downloads</h1><div class="page-description">Manage recent download activity stored on this device.</div></div><div class="page-actions"><button class="button-secondary" data-action="open-download-folder">Open folder</button><button class="button-danger" data-action="clear-downloads">Clear list</button></div></div><div class="data-table">${items}</div></div>`;
  }

  async function renderCommands() {
    const restoreSearchFocus = document.activeElement?.id === 'command-search-input';
    const searchCursor = restoreSearchFocus ? document.activeElement.selectionStart : null;
    pageContent.innerHTML = `<div class="page-wrap"><div class="page-heading"><div><div class="page-eyebrow">LOCAL COMMAND LIBRARY</div><h1 class="page-title">Search commands</h1><div class="page-description">Type a shortcut in the address bar followed by your query. For example, <code>!ytc TechnOGamerz</code> searches YouTube channels. Search shortcuts are resolved locally.</div></div><div class="page-actions"><button class="button-secondary" data-action="refresh-commands">Update library</button><button class="button-secondary" data-action="export-custom-commands">Export custom</button><button class="button-secondary" data-action="import-custom-commands">Import custom</button></div></div><div class="banner"><span>⌘</span><div><strong>${Number(snapshot.bangCount || 0).toLocaleString()} commands available</strong><br>The release workflow downloads and validates the public shortcut directory. Your personal commands stay on this device and are checked before use.</div></div>${setting('customBangManager', true) ? `<section class="about-card command-builder"><h3>Add a personal command</h3><p>Use a unique or overriding shortcut such as <code>!docs</code>. The URL must contain <code>{query}</code> and use HTTP(S).</p><form id="custom-bang-form" class="command-add-form"><input id="custom-bang-key" required maxlength="80" placeholder="!docs" aria-label="Shortcut"><input id="custom-bang-name" required maxlength="160" placeholder="Display name" aria-label="Display name"><input id="custom-bang-domain" maxlength="200" placeholder="Domain (optional)" aria-label="Domain"><input id="custom-bang-url" required maxlength="2048" placeholder="https://docs.example/search?q={query}" aria-label="Search URL template"><button class="button-primary" type="submit">Save command</button></form></section>` : ''}<div class="command-toolbar"><input id="command-search-input" placeholder="Search commands, providers, or domains…" value="${escapeHtml(commandsSearch)}"><select id="command-category"><option value="">All categories</option></select></div><div id="command-list" class="data-table"><div class="empty-state">Loading local commands…</div></div><div class="page-actions" style="justify-content:center;margin-top:14px"><button class="button-secondary" data-action="commands-load-more">Load more</button></div></div>`;
    const result = await window.lithium.listCommands({ query: commandsSearch, category: commandsCategory, limit: commandsLimit });
    if (currentRoute() !== 'commands') return;
    const categoriesResult = await window.lithium.listCommands({ limit: 500 });
    const categories = [...new Set(categoriesResult.items.map(item => item.c || 'Other'))].sort((a,b)=>a.localeCompare(b));
    const cat = $('#command-category');
    if (cat) cat.innerHTML = `<option value="">All categories</option>${categories.map(value => `<option value="${escapeHtml(value)}" ${value === commandsCategory ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}`;
    const list = $('#command-list');
    if (!list) return;
    list.innerHTML = result.items.length ? result.items.map(item => `<div class="command-row"><span class="command-key">${escapeHtml(item.t)}</span><span class="command-name">${escapeHtml(item.s || item.t)}</span><span class="command-domain">${escapeHtml(item.d || item.c || '')}${item.custom ? ' · Custom' : ''}</span>${item.custom && setting('customBangManager', true) ? `<button class="button-secondary command-remove" data-remove-custom-bang="${escapeHtml(item.t)}" title="Remove custom shortcut">Remove</button>` : ''}</div>`).join('') : '<div class="empty-state">No commands matched this search.</div>';
    const loadMore = $('[data-action="commands-load-more"]');
    if (loadMore) { loadMore.disabled = result.items.length >= result.total || result.items.length < commandsLimit; loadMore.textContent = `Showing ${result.items.length.toLocaleString()} of ${result.total.toLocaleString()}`; }
    if (restoreSearchFocus) { const input = $('#command-search-input'); input?.focus(); if (input && Number.isInteger(searchCursor)) input.setSelectionRange(searchCursor, searchCursor); }
  }

  function renderPrivacy() {
    const enabled = setting('trackerProtection', true);
    const thirdParty = setting('blockThirdPartyCookies', true);
    pageContent.innerHTML = `<div class="page-wrap"><div class="page-heading"><div><div class="page-eyebrow">LITHIUM SHIELD</div><h1 class="page-title">Privacy report</h1><div class="page-description">Local protections currently configured for this profile. Counts are not invented: this first build does not claim a live tracker-block count.</div></div><div class="page-actions"><button class="button-secondary" data-route="settings">All privacy settings</button></div></div><div class="metrics-grid"><div class="metric-card"><div class="metric-label">Known tracker blocking</div><div class="metric-value">${enabled ? 'On' : 'Off'}</div><div class="metric-sub">Local domain list</div></div><div class="metric-card"><div class="metric-label">Third-party cookies</div><div class="metric-value">${thirdParty ? 'Restricted' : 'Allowed'}</div><div class="metric-sub">Heuristic request-header filtering</div></div><div class="metric-card"><div class="metric-label">Product telemetry</div><div class="metric-value">Off</div><div class="metric-sub">No Lithium analytics endpoint</div></div></div><div class="about-card"><h3>What is active</h3><ul><li>Known tracker-domain blocking using a small bundled list.</li><li>Optional stripping of common campaign parameters on typed/top-level URLs.</li><li>DNT and Global Privacy Control headers can be sent when enabled.</li><li>Site permission requests are denied by default unless you enable the related global setting.</li><li>Local history can be disabled, and selected site data can be cleared on exit.</li></ul></div><div class="about-card"><h3>What this does not guarantee</h3><p>Lithium does not promise complete anonymity, advanced anti-fingerprinting protection, built-in VPN service, or a full Chromium fork in this first source milestone. Website requests still go to the selected website or search provider. Use the per-site controls and review provider privacy policies.</p></div></div>`;
  }

  async function renderAbout() {
    const info = appInfo || {};
    pageContent.innerHTML = `<div class="page-wrap"><div class="page-heading"><div><div class="page-eyebrow">ABOUT THE PROJECT</div><h1 class="page-title">Lithium Browser</h1><div class="page-description">A privacy-focused, highly customizable browser project built around Chromium through Electron for the first Windows release.</div></div></div>${setting('showProcessDiagnostics', true) ? `<div class="metrics-grid"><div class="metric-card"><div class="metric-label">Lithium version</div><div class="metric-value">${escapeHtml(info.version || snapshot.version || '0.2.0')}</div><div class="metric-sub">Early preview</div></div><div class="metric-card"><div class="metric-label">Chromium engine</div><div class="metric-value">${escapeHtml(info.chromium || 'Provided by Electron')}</div><div class="metric-sub">Embedded Chromium runtime</div></div><div class="metric-card"><div class="metric-label">Bang directory</div><div class="metric-value">${Number(snapshot.bangCount || 0).toLocaleString()}</div><div class="metric-sub">Available local shortcuts</div></div></div>` : ''}<div class="about-card"><h3>Built around these principles</h3><ul><li>Local-first preferences; no Lithium account system.</li><li>Customizable settings, search engines, shortcuts, themes, tabs, and bookmarks.</li><li>Security-sensitive features are clearly labelled; unsupported features are not represented as working.</li><li>The build workflow produces Windows installer and portable executables when run in GitHub Actions.</li></ul></div>${setting('exportDiagnostics', true) ? '<div class="about-card"><h3>Diagnostic export</h3><p>Exports basic technical metadata and feature counts. The diagnostics report does not include browsing history, passwords, bookmarks, or page contents.</p><button class="button-secondary" data-action="export-diagnostics">Export diagnostics</button></div>' : ''}<div class="about-card"><h3>Project status</h3><p>This is the first working source milestone, not a production-audited Chromium fork. Before public release, test downloads, session cleanup, permissions, tracker-filter correctness, and Windows packaging. The release workflow downloads the full shortcut catalog during packaging.</p></div></div>`;
  }

  function renderHelp() {
    pageContent.innerHTML = `<div class="page-wrap"><div class="page-heading"><div><div class="page-eyebrow">QUICK REFERENCE</div><h1 class="page-title">Help & shortcuts</h1><div class="page-description">A small reference for navigating Lithium.</div></div></div><div class="data-table">
    ${[['Ctrl+L','Focus the address bar'],['Ctrl+T','Open a new tab'],['Ctrl+W','Close the active tab'],['Ctrl+Shift+T','Reopen a closed tab'],['Ctrl+R / F5','Reload the current page'],['Ctrl+D','Bookmark the current page'],['Ctrl+H','Open history'],['Ctrl+J','Open downloads'],['Ctrl+,','Open settings'],['Ctrl+Shift+I','Open DevTools if enabled'],['!yt cats','Search YouTube'],['!ytc TechnOGamerz','Search YouTube channels'],['!gh electron','Search GitHub']].map(([key,description])=>`<div class="data-item"><span class="command-key">${escapeHtml(key)}</span><div class="data-item-main"><span class="data-item-title">${escapeHtml(description)}</span></div></div>`).join('')}
    </div><div class="about-card" style="margin-top:15px"><h3>Need a direct URL?</h3><p>Type a web address such as <code>example.com</code>, a search query, or a command. Commands are matched against a local library so text does not get sent to a command lookup service. The destination website still receives the search query.</p></div></div>`;
  }

  async function renderPage(force = false) {
    const tab = activeTab();
    const route = tab?.route || null;
    const token = `${tab?.id || 'none'}:${route || 'web'}`;
    if (!force && token === currentPageToken) return;
    currentPageToken = token;
    closeSuggestions();
    if (!tab) { pageContent.innerHTML = ''; return; }
    if (!route) {
      pageContent.innerHTML = '';
      await window.lithium.setViewMode(tab.id, 'web');
      updateStageBounds();
      return;
    }
    await window.lithium.setViewMode(tab.id, 'internal');
    if (route === 'newtab') pageContent.innerHTML = startPage();
    else if (route === 'settings') renderSettings();
    else if (route === 'history') { window.__lithiumHistory = await window.lithium.getHistory(); if (currentRoute() === 'history') renderHistory(); }
    else if (route === 'bookmarks') renderBookmarks();
    else if (route === 'downloads') await renderDownloads();
    else if (route === 'commands') await renderCommands();
    else if (route === 'privacy') renderPrivacy();
    else if (route === 'about') await renderAbout();
    else if (route === 'help') renderHelp();
    else renderSettings();
    updateStageBounds();
  }

  function updateSettingControlValues() {
    $$('[data-setting]').forEach(control => {
      const key = control.dataset.setting;
      const value = setting(key, undefined);
      if (value === undefined) return;
      if (control.type === 'checkbox') control.checked = value === true;
      else if (document.activeElement !== control) control.value = String(value);
    });
  }

  async function applySnapshot(next, initial = false) {
    snapshot = next || snapshot;
    applyAppearance();
    renderTabs();
    const active = activeTab();
    if (initial || active?.route !== currentPageToken.split(':').slice(1).join(':') || `${active?.id || 'none'}:${active?.route || 'web'}` !== currentPageToken) await renderPage(true);
    else if (active && !active.route) updateStageBounds();
  }

  async function gotoInput(raw, forcedNewTab = false) {
    const input = String(raw || '').trim();
    if (!input) return;
    closeSuggestions();
    if (/^lithium:\/\//i.test(input)) {
      const route = input.slice('lithium://'.length).split(/[/?#]/)[0].toLowerCase();
      const valid = ['newtab', 'settings', 'history', 'downloads', 'bookmarks', 'commands', 'about', 'privacy', 'help'].includes(route) ? route : 'newtab';
      if (forcedNewTab) await window.lithium.newTab({ background: false });
      await window.lithium.openInternal(valid);
      return;
    }
    const result = await window.lithium.resolveInput(input);
    if (!result || result.kind === 'empty') return;
    if (result.kind === 'bang-no-query') {
      toast(`${result.command} · ${result.name}: add a search term after the command.`);
      showSuggestions(input);
      address.focus();
      return;
    }
    if (result.kind === 'error') { toast(result.message, 'error'); return; }
    let tab = activeTab();
    const wantsNewTab = forcedNewTab || (setting('openSearchInNewTab', false) && (result.kind === 'search' || result.kind === 'bang'));
    if (wantsNewTab) {
      const opened = await window.lithium.newTab({ background: setting('searchInNewTabBackground', false) === true });
      if (opened?.tabId) tab = { id: opened.tabId, route: 'newtab' };
      await waitForStateTab(opened?.tabId);
      tab = activeTab();
      if (!tab || tab.id !== opened?.tabId) tab = snapshot.tabs.find(item => item.id === opened?.tabId) || tab;
    }
    if (!tab) return;
    if (result.kind === 'bang' && setting('bangOpenExternalResults', false)) {
      const opened = await window.lithium.openExternal(result.url);
      if (opened?.ok) { toast(`Opened ${result.name} in your default browser.`); return; }
    }
    const response = await window.lithium.navigate(tab.id, result.url, { kind: result.kind });
    if (!response?.ok) toast(response?.error || 'Could not open this address.', 'error');
    else {
      address.blur(); addressWasFocused = false;
      $('#status-message').textContent = result.kind === 'bang' ? `${result.command} → ${result.name}` : result.kind === 'search' ? `Searching with ${getEngineLabel(result.engine)}` : 'Opening page…';
    }
  }

  async function waitForStateTab(id) {
    if (!id || snapshot.tabs.some(tab => tab.id === id)) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }

  function closeSuggestions() { suggestions = []; selectedSuggestion = -1; suggestionsBox.classList.add('hidden'); suggestionsBox.innerHTML = ''; }
  function renderSuggestions(items, input) {
    suggestions = items;
    selectedSuggestion = -1;
    if (!items.length || !setting('addressSuggestions', true)) { closeSuggestions(); return; }
    suggestionsBox.innerHTML = items.map((item, index) => `<button class="suggestion" role="option" aria-selected="false" data-suggestion-index="${index}"><span class="suggestion-symbol">${escapeHtml(item.symbol || symbolFor(item.command || item.title))}</span><span class="suggestion-copy"><span class="suggestion-title">${escapeHtml(item.title || item.name || item.command || '')}</span><span class="suggestion-meta">${escapeHtml(item.meta || item.url || item.domain || '')}</span></span><span class="suggestion-hint">${escapeHtml(item.hint || 'Enter')}</span></button>`).join('');
    suggestionsBox.classList.remove('hidden');
  }
  async function showSuggestions(input) {
    const text = String(input || '').trim();
    if (!text || !setting('addressSuggestions', true) || setting('searchSuggestionSource', 'local') === 'off') return closeSuggestions();
    const max = Number(setting('maxAddressSuggestions', 8)) || 8;
    const list = [];
    const prefix = String(setting('bangPrefix', '!'));
    const token = text.split(/\s+/)[0];
    if (setting('enableBangCommands', true) && setting('commandSuggestions', true) && token.startsWith(prefix)) {
      const matches = await window.lithium.searchCommands(token, max);
      for (const item of matches) list.push({ kind: 'bang', command: item.t, title: `${item.t} · ${item.s}`, meta: `${setting('showBangProvider', true) ? (item.d || item.c || 'Search shortcut') : 'Search shortcut'}${text.includes(' ') ? ` · ${text.slice(text.indexOf(' ') + 1)}` : ''}`, hint: 'Tab to complete', symbol: '!' });
    } else {
      if (setting('bookmarkSuggestions', true)) {
        (snapshot.bookmarks || []).filter(item => `${item.title} ${item.url}`.toLowerCase().includes(text.toLowerCase())).slice(0, 3).forEach(item => list.push({ kind: 'url', title: item.title || item.url, url: item.url, meta: 'Bookmark', hint: 'Open', symbol: '✧' }));
      }
      if (setting('historySuggestions', true)) {
        try { const history = await window.lithium.getHistory(); history.filter(item => `${item.title} ${item.url}`.toLowerCase().includes(text.toLowerCase())).slice(0, 3).forEach(item => { if (!list.some(existing => existing.url === item.url)) list.push({ kind: 'url', title: item.title || item.url, url: item.url, meta: 'Local history', hint: 'Open', symbol: '◷' }); }); } catch {}
      }
      list.push({ kind: 'search', title: `Search for “${text}”`, query: text, meta: getEngineLabel(setting('defaultSearchEngine', 'duckduckgo')), hint: 'Enter', symbol: '⌕' });
    }
    renderSuggestions(list.slice(0, max), text);
  }
  function moveSuggestion(delta) {
    if (suggestionsBox.classList.contains('hidden') || !suggestions.length) return false;
    selectedSuggestion = (selectedSuggestion + delta + suggestions.length) % suggestions.length;
    $$('.suggestion', suggestionsBox).forEach((el, index) => { el.classList.toggle('active', index === selectedSuggestion); el.setAttribute('aria-selected', String(index === selectedSuggestion)); });
    $$('.suggestion', suggestionsBox)[selectedSuggestion]?.scrollIntoView({ block: 'nearest' });
    return true;
  }
  async function executeSuggestion(index) {
    const item = suggestions[index]; if (!item) return;
    if (item.kind === 'bang') { address.value = `${item.command} ${address.value.split(/\s+/).slice(1).join(' ')}`.trimEnd() + ' '; address.focus(); closeSuggestions(); }
    else if (item.kind === 'url') { closeSuggestions(); await gotoInput(item.url); }
    else { closeSuggestions(); await gotoInput(item.query); }
  }

  function renderMenu() {
    const rows = [
      ['＋', 'New tab', 'Ctrl+T', 'new-tab'], ['⚙', 'Settings', 'Ctrl+,', 'settings'], ['⌘', 'Search commands', '', 'commands'], ['✧', 'Bookmarks', '', 'bookmarks'], ['◷', 'History', 'Ctrl+H', 'history'], ['↓', 'Downloads', 'Ctrl+J', 'downloads'], ['⬡', 'Privacy report', '', 'privacy'], ['?', 'Help & shortcuts', '', 'help'], ['ⓘ', 'About Lithium', '', 'about'],
    ];
    menu.innerHTML = `${rows.map(([symbol, label, shortcut, action]) => `<button class="menu-item" data-menu-action="${action}"><span class="menu-symbol">${symbol}</span><span>${label}</span>${shortcut ? `<span class="menu-shortcut">${shortcut}</span>` : ''}</button>`).join('')}<div class="menu-divider"></div><button class="menu-item" data-action="export-settings"><span class="menu-symbol">↗</span><span>Export settings</span></button>${setting('showQuitButton', true) ? '<button class="menu-item" data-menu-action="quit"><span class="menu-symbol">×</span><span>Close Lithium</span></button>' : ''}`;
  }
  function toggleMenu(force) { menuOpen = force === undefined ? !menuOpen : force; menu.classList.toggle('hidden', !menuOpen); if (menuOpen) renderMenu(); }

  async function routeClick(route) {
    closeSuggestions(); toggleMenu(false);
    if (route === 'new-tab') { await window.lithium.newTab({}); return; }
    await window.lithium.openInternal(route);
  }

  async function updateSetting(key, value) {
    const result = await window.lithium.updateSetting(key, value);
    if (!result?.ok) { toast(result?.error || 'Setting could not be changed.', 'error'); return; }
    snapshot.settings = result.settings;
    applyAppearance();
    if (result.restartRequired) toast(`${catalog.find(item => item.id === key)?.label || 'Setting'} saved. Restart Lithium to apply it.`);
    else toast(`${catalog.find(item => item.id === key)?.label || 'Setting'} updated.`);
    if (['showNewTabClock','showSearchCard','showQuickLinks','newTabLayout','newTabBackground','customWallpaperUrl'].includes(key) && currentRoute() === 'newtab') await renderPage(true);
  }

  async function handleAction(action, element) {
    toggleMenu(false);
    if (action === 'export-settings') { const result = await window.lithium.exportSettings(); if (result?.ok) toast('Settings exported.'); }
    else if (action === 'import-settings') { const result = await window.lithium.importSettings(); if (result?.ok) { snapshot.settings = result.settings; applyAppearance(); await renderPage(true); const extra = result.bookmarksImported ? ` ${result.bookmarksImported} bookmarks imported.` : ''; toast(`Settings imported (${result.applied ?? 0} preferences).${extra}`); } else if (result?.error) toast(result.error, 'error'); }
    else if (action === 'reset-settings') { if (confirm('Reset all available Lithium preferences to their defaults? This will not clear bookmarks, history, or downloads.')) { const result = await window.lithium.resetSettings(); snapshot.settings = result.settings; settingsSearch = ''; currentSettingsCategory = 'General'; applyAppearance(); await renderPage(true); toast(result.restartRequired ? 'Preferences reset. Restart Lithium to apply engine-level defaults.' : 'Preferences reset to defaults.'); } }
    else if (action === 'clear-history') { await window.lithium.clearHistory(); window.__lithiumHistory = []; renderHistory(); toast('Local history cleared.'); }
    else if (action === 'open-download-folder') { await window.lithium.openDownloadsFolder(); }
    else if (action === 'clear-downloads') { await window.lithium.clearDownloads(); renderDownloads(); toast('Download list cleared. Files were not deleted.'); }
    else if (action === 'refresh-commands') { const result = await window.lithium.refreshCommands(); if (result.ok) { snapshot.bangCount = result.count; renderTabs(); toast(`Updated ${result.count.toLocaleString()} search commands.`); } else toast(`Could not update commands: ${result.error}`, 'error'); await renderCommands(); }
    else if (action === 'export-custom-commands') { const result = await window.lithium.exportCustomCommands(); if (result?.ok) toast(`Exported ${result.count} custom commands.`); }
    else if (action === 'import-custom-commands') { const result = await window.lithium.importCustomCommands(); if (result?.ok) { snapshot.bangCount = (await window.lithium.getState()).bangCount; renderTabs(); await renderCommands(); toast(`Imported ${result.imported ?? result.count} shortcuts · ${result.count} custom total.`); } else if (result?.error) toast(result.error, 'error'); }
    else if (action === 'commands-load-more') { commandsLimit += 200; await renderCommands(); }
    else if (action === 'export-diagnostics') { const result = await window.lithium.exportDiagnostics(); if (result?.ok) toast('Diagnostics exported. No browsing history was included.'); }
    else if (action === 'reset-settings-inline') { await routeClick('settings'); }
    else if (action === 'zoom-in') { await window.lithium.setZoom(activeTab()?.id, Math.min(2, Number(activeTab()?.zoom || 1) + .1)); }
  }

  // Global interactions: all browser navigation goes through the restricted preload API.
  $('#window-minimize').addEventListener('click', () => window.lithium.windowControl('minimize'));
  $('#window-maximize').addEventListener('click', async () => { await window.lithium.windowControl('toggle-maximize'); maximized = await window.lithium.isMaximized(); $('#window-maximize').title = maximized ? 'Restore' : 'Maximize'; });
  $('#window-close').addEventListener('click', () => window.lithium.windowControl('close'));
  $('#nav-back').addEventListener('click', () => { const tab = activeTab(); if (tab) window.lithium.back(tab.id); });
  $('#nav-forward').addEventListener('click', () => { const tab = activeTab(); if (tab) window.lithium.forward(tab.id); });
  $('#nav-reload').addEventListener('click', () => { const tab = activeTab(); if (tab) window.lithium.reload(tab.id); });
  $('#nav-home').addEventListener('click', async () => { const tab = activeTab(); if (tab) await window.lithium.home(tab.id); });
  $('#nav-bookmark').addEventListener('click', async () => { const tab = activeTab(); if (!tab) return; const result = await window.lithium.bookmarkToggle(tab.id); if (result?.ok) toast(result.bookmarked ? 'Bookmark added.' : 'Bookmark removed.'); });
  $('#nav-shield').addEventListener('click', async () => routeClick('privacy'));
  $('#nav-downloads').addEventListener('click', async () => routeClick('downloads'));
  $('#app-menu-button').addEventListener('click', event => { event.stopPropagation(); toggleMenu(); });
  $('#new-tab-button')?.addEventListener('click', () => window.lithium.newTab({}));
  $('#tab-strip').addEventListener('auxclick', async event => {
    if (event.button !== 1 || setting('middleClickClosesTab', true) === false) return;
    const tabButton = event.target.closest('[data-tab-id]');
    if (tabButton) { event.preventDefault(); await window.lithium.closeTab(tabButton.dataset.tabId); }
  });

  address.addEventListener('focus', () => {
    addressWasFocused = true;
    const tab = activeTab();
    if (tab && !tab.route && setting('addressAutoSelect', true)) address.select();
    else address.setSelectionRange(address.value.length, address.value.length);
  });
  address.addEventListener('blur', () => { addressWasFocused = false; setTimeout(() => { if (!suggestionsBox.matches(':hover')) closeSuggestions(); updateAddressBar(); }, 120); });
  address.addEventListener('input', () => { clearTimeout(suggestionTimer); suggestionTimer = setTimeout(() => showSuggestions(address.value), 70); });
  address.addEventListener('keydown', async event => {
    if (event.key === 'ArrowDown' && !suggestionsBox.classList.contains('hidden')) { event.preventDefault(); moveSuggestion(1); }
    else if (event.key === 'ArrowUp' && !suggestionsBox.classList.contains('hidden')) { event.preventDefault(); moveSuggestion(-1); }
    else if (event.key === 'Tab' && !suggestionsBox.classList.contains('hidden')) { event.preventDefault(); const item = suggestions[selectedSuggestion >= 0 ? selectedSuggestion : 0]; if (item?.kind === 'bang') { address.value = `${item.command} ${address.value.split(/\s+/).slice(1).join(' ')}`.trimEnd() + ' '; } closeSuggestions(); }
    else if (event.key === 'Enter') { event.preventDefault(); if (selectedSuggestion >= 0) await executeSuggestion(selectedSuggestion); else await gotoInput(address.value); }
    else if (event.key === 'Escape') { closeSuggestions(); updateAddressBar(); }
  });
  suggestionsBox.addEventListener('mousedown', event => event.preventDefault());
  suggestionsBox.addEventListener('click', async event => { const button = event.target.closest('[data-suggestion-index]'); if (button) await executeSuggestion(Number(button.dataset.suggestionIndex)); });

  document.addEventListener('click', async event => {
    const tabButton = event.target.closest('[data-tab-id]');
    if (tabButton) {
      const closeId = event.target.closest('[data-close-tab]')?.dataset.closeTab;
      if (closeId) { event.stopPropagation(); await window.lithium.closeTab(closeId); }
      else await window.lithium.activateTab(tabButton.dataset.tabId);
      return;
    }
    if (event.target.closest('#new-tab-button')) { await window.lithium.newTab({}); return; }
    const routeEl = event.target.closest('[data-route]');
    if (routeEl && routeEl.dataset.route) { await routeClick(routeEl.dataset.route); return; }
    const urlEl = event.target.closest('[data-open-url], [data-url]');
    if (urlEl) { const url = urlEl.dataset.openUrl || urlEl.dataset.url; if (url) await gotoInput(url); return; }
    const removeCustomBang = event.target.closest('[data-remove-custom-bang]');
    if (removeCustomBang) {
      const result = await window.lithium.removeCustomCommand(removeCustomBang.dataset.removeCustomBang);
      if (result?.ok) { snapshot.bangCount = (await window.lithium.getState()).bangCount; await renderCommands(); toast('Custom shortcut removed.'); }
      else toast(result?.error || 'Could not remove shortcut.', 'error');
      return;
    }
    const removeBookmark = event.target.closest('[data-remove-bookmark]');
    if (removeBookmark) { await window.lithium.removeBookmark(removeBookmark.dataset.removeBookmark); await renderBookmarks(); renderBookmarksBar(); return; }
    const copyUrl = event.target.closest('[data-copy-url]');
    if (copyUrl) { try { await navigator.clipboard.writeText(copyUrl.dataset.copyUrl); toast('URL copied.'); } catch { toast(copyUrl.dataset.copyUrl); } return; }
    const settingsCategory = event.target.closest('[data-settings-category]');
    if (settingsCategory) { currentSettingsCategory = settingsCategory.dataset.settingsCategory; settingsSearch = ''; renderSettings(); updateStageBounds(); return; }
    const actionEl = event.target.closest('[data-action]');
    if (actionEl) { await handleAction(actionEl.dataset.action, actionEl); return; }
    const menuAction = event.target.closest('[data-menu-action]');
    if (menuAction) { const action = menuAction.dataset.menuAction; toggleMenu(false); if (action === 'new-tab') await routeClick('new-tab'); else if (action === 'quit') await window.lithium.windowControl('close'); else await routeClick(action); return; }
    if (!event.target.closest('#app-menu-button') && !event.target.closest('#app-menu')) toggleMenu(false);
  });

  document.addEventListener('change', async event => {
    const control = event.target.closest('[data-setting]');
    if (control) {
      const item = catalog.find(schema => schema.id === control.dataset.setting);
      if (!item || item.status !== 'available') return;
      let value;
      if (control.type === 'checkbox') value = control.checked;
      else if (control.type === 'number') value = Number(control.value);
      else value = control.value;
      await updateSetting(item.id, value);
      return;
    }
    if (event.target.id === 'command-category') { commandsCategory = event.target.value; commandsLimit = 200; await renderCommands(); }
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'settings-search-input') {
      const cursor = event.target.selectionStart; settingsSearch = event.target.value; renderSettings(); const input = $('#settings-search-input'); input?.focus(); input?.setSelectionRange(cursor, cursor); return;
    }
    if (event.target.id === 'command-search-input') {
      const cursor = event.target.selectionStart; commandsSearch = event.target.value; commandsLimit = 200; clearTimeout(suggestionTimer); suggestionTimer = setTimeout(() => { if (currentRoute() === 'commands') renderCommands(); }, 140); return;
    }
  });
  pageContent.addEventListener('submit', async event => {
    if (event.target.id === 'start-search-form') { event.preventDefault(); await gotoInput($('#start-search-input')?.value || ''); }
    else if (event.target.id === 'custom-bang-form') {
      event.preventDefault();
      const result = await window.lithium.addCustomCommand({
        t: $('#custom-bang-key')?.value || '',
        s: $('#custom-bang-name')?.value || '',
        d: $('#custom-bang-domain')?.value || '',
        u: $('#custom-bang-url')?.value || '',
      });
      if (!result?.ok) { toast(result?.error || 'Could not save custom command.', 'error'); return; }
      snapshot.bangCount = (await window.lithium.getState()).bangCount;
      commandsSearch = result.command;
      commandsLimit = 200;
      await renderCommands();
      toast(`Saved ${result.command}.`);
    }
  });
  pageContent.addEventListener('keydown', async event => {
    if (event.target.id === 'command-search-input' && event.key === 'Enter') { event.preventDefault(); commandsSearch = event.target.value; await renderCommands(); }
  });
  pageContent.addEventListener('input', event => {
    if (event.target.id === 'command-search-input') commandsSearch = event.target.value;
  });

  document.addEventListener('keydown', async event => {
    const control = event.ctrlKey || event.metaKey;
    if (control && event.key.toLowerCase() === 'l') { event.preventDefault(); address.focus(); address.select(); }
    else if (control && event.key.toLowerCase() === 't') { event.preventDefault(); await window.lithium.newTab({}); }
    else if (control && event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); await window.lithium.reopenClosed(); }
    else if (control && event.key.toLowerCase() === 'w' && document.activeElement !== address && !document.activeElement.closest('.page-content input')) { event.preventDefault(); const tab = activeTab(); if (tab) await window.lithium.closeTab(tab.id); }
    else if (control && event.key.toLowerCase() === 'h') { event.preventDefault(); await routeClick('history'); }
    else if (control && event.key.toLowerCase() === 'j') { event.preventDefault(); await routeClick('downloads'); }
    else if (control && event.key === ',') { event.preventDefault(); await routeClick('settings'); }
    else if (event.altKey && event.key === 'ArrowLeft') { const tab = activeTab(); if (tab) window.lithium.back(tab.id); }
    else if (event.altKey && event.key === 'ArrowRight') { const tab = activeTab(); if (tab) window.lithium.forward(tab.id); }
  });

  const resizeObserver = new ResizeObserver(() => updateStageBounds());
  resizeObserver.observe(stage);
  window.addEventListener('resize', updateStageBounds);
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (setting('theme') === 'system') applyAppearance(); });

  window.lithium.onState(next => { const previousId = snapshot.activeTabId; const previousRoute = currentRoute(); snapshot = next; applyAppearance(); renderTabs(); if (previousId !== snapshot.activeTabId || previousRoute !== currentRoute()) { renderPage(true); } else if (!isCurrentInternal()) updateStageBounds(); });
  window.lithium.onSettingsChanged(next => { snapshot.settings = next; applyAppearance(); });
  window.lithium.onFocusAddress(() => { address.focus(); address.select(); });
  window.lithium.onLoadError(payload => { if (payload.tabId === snapshot.activeTabId) toast(`Page failed to load: ${payload.errorDescription || payload.errorCode}`, 'error'); });
  window.lithium.onRenderGone(payload => { if (payload.tabId === snapshot.activeTabId) toast(`Page process stopped (${payload.reason}). Reload the tab to try again.`, 'error'); });
  window.lithium.onDownloadsChanged(() => { if (currentRoute() === 'downloads') renderDownloads(); });
  window.lithium.onMaximizedChanged(value => { maximized = value; $('#window-maximize').title = value ? 'Restore' : 'Maximize'; });

  (async function boot() {
    try {
      appInfo = await window.lithium.appInfo();
      catalog = await window.lithium.getCatalog();
        // Search-engine names are bundled in this UI; no network request is made.
      catalog._engines = [
        { id: 'duckduckgo', name: 'DuckDuckGo' }, { id: 'google', name: 'Google' }, { id: 'brave', name: 'Brave Search' }, { id: 'startpage', name: 'Startpage' }, { id: 'bing', name: 'Bing' }, { id: 'ecosia', name: 'Ecosia' }, { id: 'qwant', name: 'Qwant' }, { id: 'mojeek', name: 'Mojeek' }, { id: 'custom', name: 'Custom search URL' },
      ];
      const next = await window.lithium.getState();
      snapshot = next;
      currentSettingsCategory = 'General';
      applyAppearance();
      renderTabs();
      await renderPage(true);
      renderBookmarksBar();
      $('#brand-version').textContent = `PREVIEW ${appInfo.version || '0.2.0'}`;
      statusMessage.textContent = 'Ready · no Lithium account · no product telemetry';
      updateStageBounds();
    } catch (error) {
      pageContent.innerHTML = `<div class="empty-state">Lithium could not initialize its UI.<br>${escapeHtml(error.message)}</div>`;
    }
  })();

  setInterval(() => {
    const clock = $('#local-clock');
    if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, 30_000);
})();
