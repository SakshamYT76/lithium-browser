'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, shell, net, Notification, Menu } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildBangIndex, isSafeBangTemplate, resolveInput, searchBangs } = require('./src/bang-resolver.cjs');
const { normalizeCustomBang, normalizeCustomBangList } = require('./src/custom-bangs.cjs');
const { safeHttpUrl } = require('./src/url-policy.cjs');

const APP_NAME = 'Lithium';
const VERSION = app.getVersion();
const ROOT = __dirname;
const RESOURCES = path.join(ROOT, 'resources');
const CATALOG = JSON.parse(fs.readFileSync(path.join(RESOURCES, 'settings-catalog.json'), 'utf8'));
const ENGINES = JSON.parse(fs.readFileSync(path.join(RESOURCES, 'search-engines.json'), 'utf8'));
const TRACKERS = new Set(fs.readFileSync(path.join(RESOURCES, 'tracker-domains.txt'), 'utf8').split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean));
const DEFAULT_SETTINGS = Object.fromEntries(CATALOG.map(item => [item.id, item.default]));
const settingsById = new Map(CATALOG.map(item => [item.id, item]));
const state = {
  window: null,
  browserSession: null,
  tabs: new Map(),
  activeTabId: null,
  closedTabs: [],
  history: [],
  downloads: [],
  bookmarks: [],
  settings: { ...DEFAULT_SETTINGS },
  bangItems: [],
  customBangItems: [],
  bangIndex: buildBangIndex([]),
  quitting: false,
  resizeBounds: null,
  windowBounds: null,
};

function userFile(name) { return path.join(app.getPath('userData'), name); }
function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonFile(file, value) {
  const folder = path.dirname(file);
  fs.mkdirSync(folder, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function defaultBangData() {
  return readJsonFile(path.join(RESOURCES, 'bangs.json'), readJsonFile(path.join(RESOURCES, 'bangs-seed.json'), []));
}
function rebuildBangIndex() {
  // User entries appear first so users may deliberately override a built-in bang.
  state.bangIndex = buildBangIndex([
    ...state.customBangItems.map(item => ({ ...item, custom: true })),
    ...state.bangItems,
  ]);
  return state.bangIndex;
}
function persistCustomBangs() {
  writeJsonFile(userFile('custom-bangs.json'), state.customBangItems);
  rebuildBangIndex();
}
function loadPersistentState() {
  const saved = readJsonFile(userFile('settings.json'), {});
  state.settings = { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(saved)) {
    // Persisted profile files are user-editable input too; apply the same
    // semantic validation used by the settings IPC instead of trusting types alone.
    if (!settingValueError(key, value)) state.settings[key] = value;
  }
  state.history = readJsonFile(userFile('history.json'), []);
  if (!Array.isArray(state.history)) state.history = [];
  state.bookmarks = readJsonFile(userFile('bookmarks.json'), []);
  if (!Array.isArray(state.bookmarks)) state.bookmarks = [];
  state.downloads = readJsonFile(userFile('downloads.json'), []);
  if (!Array.isArray(state.downloads)) state.downloads = [];
  const userBangFile = userFile('bangs.json');
  const candidate = readJsonFile(userBangFile, null);
  state.bangItems = Array.isArray(candidate) && candidate.length >= 3000 ? candidate : defaultBangData();
  const customRows = readJsonFile(userFile('custom-bangs.json'), []);
  state.customBangItems = normalizeCustomBangList(customRows, 5000);
  rebuildBangIndex();
  if (state.settings.rememberWindowBounds) {
    const bounds = readJsonFile(userFile('window-bounds.json'), null);
    if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) state.windowBounds = { width: Math.max(900, Math.min(3000, bounds.width)), height: Math.max(620, Math.min(2200, bounds.height)) };
  }
}
function isSettingValueValid(schema, value) {
  if (schema.type === 'toggle') return typeof value === 'boolean';
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (schema.type === 'select') return schema.options.some(option => option[0] === value);
  if (schema.type === 'text') return typeof value === 'string' && value.length <= 4096;
  return false;
}
function settingValueError(key, value) {
  const schema = settingsById.get(key);
  if (!schema || schema.status !== 'available') return 'This setting is not available in this build.';
  if (!isSettingValueValid(schema, value)) return 'The supplied value does not match this setting.';
  if (key === 'customSearchUrl' && value) {
    if (!value.includes('{query}') || !safeUrl(value.replace(/\{query\}/g, 'lithium-test'))) return 'Use a valid HTTP(S) search URL containing {query}.';
  }
  if (key === 'homepageUrl' && value && !safeUrl(value)) return 'Enter a valid HTTP or HTTPS URL.';
  if (key === 'downloadDirectory' && value && value.includes('\0')) return 'Invalid folder path.';
  if (key === 'customWallpaperUrl' && value && (!/^https:\/\//i.test(value) || !safeUrl(value))) return 'Wallpaper must be a valid HTTPS URL.';
  if (key === 'customAccentHex' && value && !/^#[0-9a-f]{6}$/i.test(value)) return 'Use a six-digit hex color such as #8b5cf6.';
  if (key === 'customBangAlias' && value && !/^![^\s!]+$/.test(value.trim())) return 'Use a single shortcut such as !l, with no spaces.';
  if (key === 'pageZoom' && (value < 50 || value > 200)) return 'Zoom must be between 50 and 200.';
  if (key === 'maxAddressSuggestions' && (value < 3 || value > 20)) return 'Choose between 3 and 20 suggestions.';
  return null;
}
function persistSettings() { writeJsonFile(userFile('settings.json'), state.settings); }
function persistHistory() { writeJsonFile(userFile('history.json'), state.history.slice(-5000)); }
function persistBookmarks() { writeJsonFile(userFile('bookmarks.json'), state.bookmarks); }
function persistDownloads() { writeJsonFile(userFile('downloads.json'), state.downloads.slice(-1000)); }
function safeUrl(value) { return safeHttpUrl(value); }
function isInternalRoute(route) {
  return ['newtab', 'settings', 'history', 'downloads', 'bookmarks', 'commands', 'about', 'privacy', 'help'].includes(route);
}
function sanitizeTab(tab) {
  const wc = tab.view.webContents;
  return {
    id: tab.id,
    title: tab.title || (tab.route ? routeTitle(tab.route) : 'New tab'),
    url: tab.route ? `lithium://${tab.route}` : (wc.getURL() || tab.url || 'about:blank'),
    route: tab.route,
    loading: Boolean(tab.loading),
    canGoBack: !tab.route && wc.canGoBack(),
    canGoForward: !tab.route && wc.canGoForward(),
    audioMuted: wc.isAudioMuted(),
  };
}
function routeTitle(route) {
  const titles = { newtab: 'New tab', settings: 'Settings', history: 'History', downloads: 'Downloads', bookmarks: 'Bookmarks', commands: 'Search commands', about: 'About Lithium', privacy: 'Privacy report', help: 'Help' };
  return titles[route] || 'Lithium';
}
function snapshot() {
  return {
    tabs: [...state.tabs.values()].map(sanitizeTab),
    activeTabId: state.activeTabId,
    settings: state.settings,
    bookmarks: state.bookmarks,
    bangCount: state.bangIndex.items.length,
    version: VERSION,
  };
}
function emitState() {
  if (state.window && !state.window.isDestroyed()) state.window.webContents.send('state:changed', snapshot());
  updateViewVisibility();
}
function updateViewVisibility() {
  for (const tab of state.tabs.values()) {
    const active = tab.id === state.activeTabId;
    const show = active && !tab.route && Boolean(tab.wantsWebView);
    try { tab.view.setVisible(show); } catch {}
  }
}
function applyBounds(tabId, rect) {
  const tab = state.tabs.get(tabId);
  if (!tab || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
  const normalized = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
  tab.lastBounds = normalized;
  try { tab.view.setBounds(normalized); } catch {}
}
function recordHistory(tab, url, title) {
  if (!state.settings.saveBrowsingHistory || !safeUrl(url)) return;
  const normalizedUrl = url;
  const last = state.history[state.history.length - 1];
  if (last && last.url === normalizedUrl && Date.now() - last.visitedAt < 2000) {
    last.title = title || last.title;
    last.visitedAt = Date.now();
  } else {
    state.history.push({ id: crypto.randomUUID(), url: normalizedUrl, title: title || normalizedUrl, visitedAt: Date.now() });
  }
  if (state.history.length > 5000) state.history = state.history.slice(-5000);
  persistHistory();
}
function closeTab(tabId, { force = false, remember = true } = {}) {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  if (!force && state.settings.confirmCloseTab && state.tabs.size > 1) {
    const response = dialog.showMessageBoxSync(state.window, { type: 'question', buttons: ['Close tab', 'Cancel'], defaultId: 1, cancelId: 1, message: `Close “${tab.title || 'this tab'}”?` });
    if (response !== 0) return;
  }
  if (remember && state.settings.reopenClosedTabs && !tab.route && safeUrl(tab.view.webContents.getURL())) {
    state.closedTabs.push({ url: tab.view.webContents.getURL(), title: tab.title });
    state.closedTabs = state.closedTabs.slice(-10);
  }
  const list = [...state.tabs.keys()];
  const oldIndex = list.indexOf(tabId);
  state.tabs.delete(tabId);
  try { tab.view.setVisible(false); } catch {}
  try {
    if (tab.attachedWindow && !tab.attachedWindow.isDestroyed()) tab.attachedWindow.contentView.removeChildView(tab.view);
  } catch {}
  tab.attachedWindow = null;
  try { tab.view.webContents.close({ waitForBeforeUnload: false }); } catch {}
  try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.destroy(); } catch {}
  if (state.activeTabId === tabId) {
    const remaining = [...state.tabs.keys()];
    if (remaining.length) state.activeTabId = remaining[Math.max(0, Math.min(oldIndex - 1, remaining.length - 1))];
    else if (state.settings.closeOnLastTab) {
      state.activeTabId = null;
      if (state.window && state.tabs.size === 0) state.window.close();
    } else {
      const replacement = createTab({ route: 'newtab' });
      state.activeTabId = replacement.id;
    }
  }
  emitState();
}
function activateTab(tabId) {
  if (!state.tabs.has(tabId)) return;
  state.activeTabId = tabId;
  emitState();
}
function createTab({ url = null, route = 'newtab', background = null } = {}) {
  // A null background value means the user's global preference should decide.
  // Explicit true/false is reserved for flows with their own foreground rule.
  if (background === null || background === undefined) background = state.settings.openNewTabsInBackground === true;
  const id = crypto.randomUUID();
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:lithium-browser',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      spellcheck: state.settings.enableSpellcheck === true,
      backgroundThrottling: state.settings.backgroundTabThrottling !== false,
    },
  });
  const tab = { id, view, route: isInternalRoute(route) ? route : null, url: '', title: 'New tab', loading: false, wantsWebView: false, lastBounds: { x: 0, y: 120, width: 1, height: 1 }, attachedWindow: null };
  state.tabs.set(id, tab);
  view.setBounds(tab.lastBounds);
  view.setVisible(false);
  // WebContentsView is a native view and must be attached to the BrowserWindow's
  // contentView. Without this, network pages load in the background but are never
  // painted over the browser stage, making the browser appear broken.
  if (state.window && !state.window.isDestroyed()) {
    try {
      state.window.contentView.addChildView(view);
      tab.attachedWindow = state.window;
    } catch (error) {
      console.error('Could not attach Lithium tab view:', error);
    }
  }
  const wc = view.webContents;
  wc.setBackgroundColor('#11131a');
  try { wc.setZoomFactor(Math.min(2, Math.max(0.5, (Number(state.settings.pageZoom) || 100) / 100))); } catch {}
  try { wc.setAudioMuted(state.settings.muteAllTabs === true); } catch {}
  try { wc.setBackgroundThrottling(state.settings.backgroundTabThrottling !== false && state.settings.reduceBackgroundActivity !== false); } catch {}

  wc.on('page-title-updated', (_event, title) => {
    tab.title = String(title || '').slice(0, 300);
    emitState();
  });
  wc.on('update-target-url', (_event, targetUrl) => {
    if (state.settings.showUrlOnHover && state.window && tab.id === state.activeTabId) state.window.webContents.send('ui:status-target', String(targetUrl || '').slice(0, 2048));
  });
  wc.on('did-start-loading', () => { tab.loading = true; emitState(); });
  wc.on('did-stop-loading', () => { tab.loading = false; emitState(); });
  wc.on('did-navigate', (_event, navigatedUrl) => {
    const valid = safeUrl(navigatedUrl);
    if (valid) {
      tab.route = null;
      tab.url = valid;
      tab.wantsWebView = true;
      if (tab.suppressSearchHistoryOnce) tab.suppressSearchHistoryOnce = false;
      else recordHistory(tab, valid, tab.title || valid);
    }
    emitState();
  });
  wc.on('did-navigate-in-page', (_event, navigatedUrl) => {
    const valid = safeUrl(navigatedUrl);
    if (valid) { tab.url = valid; tab.route = null; tab.wantsWebView = true; }
    emitState();
  });
  wc.on('did-fail-load', (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      tab.loading = false;
      state.window?.webContents.send('browser:load-error', { tabId: id, errorCode, errorDescription, url: failedUrl });
      emitState();
    }
  });
  wc.on('render-process-gone', (_event, details) => {
    tab.loading = false;
    state.window?.webContents.send('browser:render-gone', { tabId: id, reason: details.reason });
    emitState();
  });
  wc.on('will-navigate', (event, destination) => {
    if (/^(mailto|tel|sms):/i.test(destination)) {
      event.preventDefault();
      if (state.settings.askBeforeOpeningExternalApps) {
        const result = dialog.showMessageBoxSync(state.window, { type: 'question', buttons: ['Open external app', 'Cancel'], defaultId: 1, cancelId: 1, message: `Open this external link?\n${destination}` });
        if (result === 0) shell.openExternal(destination).catch(() => {});
      } else {
        shell.openExternal(destination).catch(() => {});
      }
      return;
    }
    if (!safeUrl(destination) && !destination.startsWith('about:blank')) event.preventDefault();
  });
  wc.setWindowOpenHandler(details => {
    const disposition = String(details.disposition || 'default');
    const frameName = String(details.frameName || '');
    const namedLinkTarget = frameName !== '' && frameName !== 'undefined';
    // Open ordinary links such as target="_blank" in a Lithium tab while
    // still rejecting anonymous script-created popups when popup blocking is on.
    if (state.settings.blockPopups !== false && !namedLinkTarget) return { action: 'deny' };
    const valid = safeUrl(details.url);
    if (!valid) return { action: 'deny' };
    if (state.settings.openExternalLinksInNewTab === false) {
      navigateTab(id, valid, { kind: 'link' });
      return { action: 'deny' };
    }
    const background = disposition === 'background-tab' || state.settings.openNewTabsInBackground === true;
    createTab({ url: valid, background });
    emitState();
    // We create and manage the new tab ourselves; never let Chromium create
    // an uncontrolled native window outside Lithium's tab model.
    return { action: 'deny' };
  });
  wc.on('before-input-event', (event, input) => handleBrowserShortcut(event, input, id));
  wc.on('context-menu', (_event, params) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Back', enabled: wc.canGoBack(), click: () => wc.goBack() },
      { label: 'Forward', enabled: wc.canGoForward(), click: () => wc.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Copy', enabled: params.editFlags.canCopy, role: 'copy' },
      { label: 'Paste', enabled: params.editFlags.canPaste, role: 'paste' },
      { label: 'Select all', enabled: params.editFlags.canSelectAll, role: 'selectAll' },
      { type: 'separator' },
      { label: 'Open Developer Tools', enabled: state.settings.developerToolsEnabled !== false, click: () => wc.openDevTools({ mode: 'detach' }) },
    ]);
    menu.popup({ window: state.window });
  });

  if (url) {
    tab.route = null;
    tab.wantsWebView = true;
    if (!background || !state.activeTabId) state.activeTabId = id;
    navigateTab(id, url);
  } else if (!background || !state.activeTabId) {
    state.activeTabId = id;
  }
  emitState();
  return tab;
}
function handleBrowserShortcut(event, input, tabId) {
  if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
  const key = String(input.key || '').toLowerCase();
  if (key === 'l' || key === 'k') { event.preventDefault(); state.window?.webContents.send('ui:focus-address'); }
  else if (key === 't') { event.preventDefault(); createTab({ route: 'newtab' }); }
  else if (key === 'w') { event.preventDefault(); closeTab(tabId); }
  else if (key === 'r') { event.preventDefault(); const tab = state.tabs.get(tabId); if (tab) tab.view.webContents.reload(); }
  else if (key === 'd') { event.preventDefault(); const tab = state.tabs.get(tabId); if (tab) addBookmark(tab.view.webContents.getURL(), tab.title); }
  else if (key === 'h') { event.preventDefault(); openInternal('history'); }
  else if (key === 'j') { event.preventDefault(); openInternal('downloads'); }
  else if (key === ',') { event.preventDefault(); openInternal('settings'); }
  else if (key === 'tab') {
    event.preventDefault();
    const ids = [...state.tabs.keys()];
    if (!ids.length) return;
    const index = ids.indexOf(state.activeTabId);
    const next = input.shift ? (index - 1 + ids.length) % ids.length : (index + 1) % ids.length;
    activateTab(ids[next]);
  }
  else if (key === 'i' && input.shift && state.settings.developerToolsEnabled) {
    event.preventDefault(); const tab = state.tabs.get(tabId); tab?.view.webContents.openDevTools({ mode: 'detach' });
  }
}
function navigateTab(tabId, url, metadata = {}) {
  const tab = state.tabs.get(tabId);
  const valid = safeUrl(url);
  if (!tab || !valid) return { ok: false, error: 'Only HTTP and HTTPS web addresses can be opened.' };
  tab.route = null;
  tab.url = valid;
  tab.wantsWebView = true;
  tab.loading = true;
  tab.suppressSearchHistoryOnce = !state.settings.rememberSearchHistory && ['search', 'bang'].includes(metadata.kind);
  // Tab activation is controlled by createTab()/the UI, not navigation. This
  // preserves background-tab behavior for restored sessions and target=_blank.
  try {
    tab.view.webContents.loadURL(valid).catch(error => {
      tab.loading = false;
      state.window?.webContents.send('browser:load-error', { tabId, errorCode: -2, errorDescription: error.message, url: valid });
      emitState();
    });
  } catch (error) {
    tab.loading = false;
    return { ok: false, error: error.message };
  }
  emitState();
  return { ok: true };
}
function openInternal(route) {
  if (!isInternalRoute(route)) route = 'newtab';
  let tab = state.tabs.get(state.activeTabId);
  if (!tab) tab = createTab({ route });
  tab.route = route;
  tab.wantsWebView = false;
  tab.loading = false;
  tab.title = routeTitle(route);
  emitState();
  return tab.id;
}
function addBookmark(url, title) {
  const valid = safeUrl(url);
  if (!valid) return { ok: false, error: 'Only web pages can be bookmarked.' };
  const existing = state.bookmarks.find(item => item.url === valid);
  if (existing) {
    state.bookmarks = state.bookmarks.filter(item => item.url !== valid);
    persistBookmarks(); emitState();
    return { ok: true, bookmarked: false };
  }
  state.bookmarks.unshift({ id: crypto.randomUUID(), url: valid, title: String(title || valid).slice(0, 200), createdAt: Date.now() });
  persistBookmarks(); emitState();
  return { ok: true, bookmarked: true };
}
function getActiveTab() { return state.tabs.get(state.activeTabId) || null; }

function permissionAllowed(permission) {
  if (state.settings.permissionPromptMode === 'deny') return false;
  const mapping = {
    notifications: 'allowSiteNotifications',
    geolocation: 'allowGeolocation',
    clipboardReadWrite: 'allowClipboardRead',
    clipboardSanitizedWrite: 'allowClipboardRead',
  };
  if (permission === 'media') return state.settings.allowCamera === true && state.settings.allowMicrophone === true;
  const settingKey = mapping[permission];
  return Boolean(settingKey && state.settings[settingKey] === true);
}
async function configureSession(browserSession) {
  // Apply the selected proxy mode before opening the first browsing tab.
  await browserSession.setProxy({ mode: state.settings.proxySettings === 'direct' ? 'direct' : 'system' });
  browserSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permissionAllowed(permission)));
  browserSession.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission));
  browserSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    try {
      const url = new URL(details.url);
      const host = url.hostname.toLowerCase();
      if (state.settings.httpsOnlyMode && details.resourceType === 'mainFrame' && url.protocol === 'http:') {
        url.protocol = 'https:';
        return callback({ redirectURL: url.toString() });
      }
      if (state.settings.trackerProtection && [...TRACKERS].some(domain => host === domain || host.endsWith(`.${domain}`))) return callback({ cancel: true });
      if (state.settings.blockImages && details.resourceType === 'image') return callback({ cancel: true });
      if (state.settings.blockRemoteFonts && details.resourceType === 'font' && details.initiator) {
        const initiatorHost = new URL(details.initiator).hostname.toLowerCase();
        if (host !== initiatorHost && !host.endsWith(`.${initiatorHost}`) && !initiatorHost.endsWith(`.${host}`)) return callback({ cancel: true });
      }
      if (state.settings.stripTrackingParameters && details.resourceType === 'mainFrame') {
        const before = url.toString();
        const tracking = /^(utm_.+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|vero_id|vero_conv|oly_anon_id|oly_enc_id|ref_src|ref_url|_hsenc|_hsmi)$/i;
        for (const key of [...url.searchParams.keys()]) if (tracking.test(key)) url.searchParams.delete(key);
        const after = url.toString();
        if (before !== after) return callback({ redirectURL: after });
      }
    } catch {}
    callback({});
  });
  browserSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (state.settings.sendDoNotTrack) headers.DNT = '1';
    if (state.settings.sendGlobalPrivacyControl) headers['Sec-GPC'] = '1';
    if (state.settings.hideReferrer && details.initiator) {
      try {
        const targetHost = new URL(details.url).hostname.toLowerCase();
        const sourceHost = new URL(details.initiator).hostname.toLowerCase();
        const sameSiteish = targetHost === sourceHost || targetHost.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${targetHost}`);
        if (!sameSiteish) delete headers.Referer;
      } catch {}
    }
    if (state.settings.blockThirdPartyCookies && headers.Cookie && details.initiator) {
      try {
        const targetHost = new URL(details.url).hostname.toLowerCase();
        const sourceHost = new URL(details.initiator).hostname.toLowerCase();
        const sameSiteish = targetHost === sourceHost || targetHost.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${targetHost}`);
        if (!sameSiteish) delete headers.Cookie;
      } catch {}
    }
    callback({ requestHeaders: headers });
  });
  browserSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!state.settings.blockThirdPartyCookies || !details.initiator || !details.responseHeaders) return callback({ responseHeaders: details.responseHeaders });
    try {
      const targetHost = new URL(details.url).hostname.toLowerCase();
      const sourceHost = new URL(details.initiator).hostname.toLowerCase();
      const sameSiteish = targetHost === sourceHost || targetHost.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${targetHost}`);
      if (!sameSiteish) {
        const cleaned = {};
        for (const [key, value] of Object.entries(details.responseHeaders)) {
          if (key.toLowerCase() !== 'set-cookie') cleaned[key] = value;
        }
        return callback({ responseHeaders: cleaned });
      }
    } catch {}
    callback({ responseHeaders: details.responseHeaders });
  });
  browserSession.on('will-download', async (event, item, webContents) => {
    let savePath;
    const extension = path.extname(item.getFilename() || '').toLowerCase();
    if (state.settings.confirmDangerousDownloads && ['.exe', '.msi', '.bat', '.cmd', '.ps1', '.scr', '.com', '.vbs', '.js'].includes(extension)) {
      item.pause();
      const answer = await dialog.showMessageBox(state.window, { type: 'warning', buttons: ['Continue download', 'Cancel download'], defaultId: 1, cancelId: 1, message: `This file can run code on your computer: ${path.basename(item.getFilename())}`, detail: 'Only open executable files when you trust the source.' });
      if (answer.response !== 0) { item.cancel(); return; }
      item.resume();
    }
    const fallbackDirectory = state.settings.downloadDirectory && state.settings.downloadDirectory.trim()
      ? path.resolve(state.settings.downloadDirectory.trim())
      : app.getPath('downloads');
    try { fs.mkdirSync(fallbackDirectory, { recursive: true }); } catch {}
    const safeName = path.basename(item.getFilename() || 'download');
    if (state.settings.askDownloadLocation) {
      // Let Electron's own download flow select the destination. This API is
      // specifically designed for the will-download event and avoids racing a
      // custom async dialog against the download lifecycle.
      item.setSaveDialogOptions({ defaultPath: path.join(fallbackDirectory, safeName), title: 'Save download' });
    } else {
      savePath = path.join(fallbackDirectory, safeName);
      try { item.setSavePath(savePath); } catch (error) { console.error('Could not set download path:', error); }
    }
    const entry = { id: crypto.randomUUID(), filename: safeName, path: savePath || path.join(fallbackDirectory, safeName), url: item.getURL(), state: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes(), startedAt: Date.now() };
    if (state.settings.saveDownloadsHistory) { state.downloads.unshift(entry); persistDownloads(); }
    const notify = () => state.window?.webContents.send('downloads:changed', state.downloads);
    item.on('updated', (_event, downloadState) => {
      entry.state = downloadState === 'interrupted' ? 'interrupted' : 'progressing';
      entry.receivedBytes = item.getReceivedBytes(); entry.totalBytes = item.getTotalBytes();
      if (state.settings.saveDownloadsHistory) persistDownloads();
      notify();
    });
    item.once('done', (_event, downloadState) => {
      entry.state = downloadState; entry.path = item.getSavePath(); entry.finishedAt = Date.now();
      if (state.settings.saveDownloadsHistory) persistDownloads();
      notify();
      if (downloadState === 'completed' && state.settings.showDownloadCompletionToast && Notification.isSupported()) {
        try { new Notification({ title: 'Lithium download complete', body: safeName }).show(); } catch {}
      }
      if (downloadState === 'completed' && state.settings.autoOpenDownloadsFolder) {
        shell.openPath(path.dirname(item.getSavePath())).catch(error => console.error('Could not open download folder:', error));
      }
      if (downloadState === 'completed' && state.settings.openDownloadsPanelOnStart) openInternal('downloads');
    });
  });
}

function handleWindowControl(action) {
  const win = state.window;
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'toggle-maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({ name: APP_NAME, version: VERSION, chromium: process.versions.chrome, electron: process.versions.electron, platform: process.platform, bangCount: state.bangIndex.items.length }));
  ipcMain.handle('state:get', () => snapshot());
  ipcMain.handle('settings:catalog', () => CATALOG);
  ipcMain.handle('settings:get', () => state.settings);
  ipcMain.handle('settings:update', (_event, key, value) => {
    const schema = settingsById.get(key);
    const validationError = settingValueError(key, value);
    if (validationError) return { ok: false, error: validationError };
    state.settings[key] = value;
    persistSettings();
    if (key === 'pageZoom') for (const tab of state.tabs.values()) try { tab.view.webContents.setZoomFactor(value / 100); } catch {}
    if (key === 'muteAllTabs') for (const tab of state.tabs.values()) try { tab.view.webContents.setAudioMuted(value); } catch {}
    if (key === 'backgroundTabThrottling' || key === 'reduceBackgroundActivity') for (const tab of state.tabs.values()) { try { tab.view.webContents.setBackgroundThrottling(state.settings.backgroundTabThrottling !== false && state.settings.reduceBackgroundActivity !== false); } catch {} }
    if (key === 'saveBrowsingHistory' && value === false) { state.history = []; persistHistory(); }
    emitState();
    state.window?.webContents.send('settings:changed', state.settings);
    return { ok: true, settings: state.settings, restartRequired: Boolean(schema.restartRequired) };
  });
  ipcMain.handle('settings:reset', async () => {
    const restartRequired = ['hardwareAcceleration', 'enableSpellcheck', 'proxySettings'].some(key => state.settings[key] !== DEFAULT_SETTINGS[key]);
    state.settings = { ...DEFAULT_SETTINGS };
    persistSettings();
    for (const tab of state.tabs.values()) {
      try { tab.view.webContents.setZoomFactor(DEFAULT_SETTINGS.pageZoom / 100); } catch {}
      try { tab.view.webContents.setAudioMuted(DEFAULT_SETTINGS.muteAllTabs); } catch {}
      try { tab.view.webContents.setBackgroundThrottling(DEFAULT_SETTINGS.backgroundTabThrottling !== false && DEFAULT_SETTINGS.reduceBackgroundActivity !== false); } catch {}
    }
    emitState();
    state.window?.webContents.send('settings:changed', state.settings);
    return { ok: true, settings: state.settings, restartRequired };
  });
  ipcMain.handle('settings:export', async () => {
    const result = await dialog.showSaveDialog(state.window, { title: 'Export Lithium settings', defaultPath: 'lithium-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    await fsp.writeFile(result.filePath, JSON.stringify({ version: VERSION, settings: state.settings, bookmarks: state.bookmarks }, null, 2), 'utf8');
    return { ok: true, path: result.filePath };
  });
  ipcMain.handle('settings:import', async () => {
    const result = await dialog.showOpenDialog(state.window, { title: 'Import Lithium settings', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    try {
      const stat = await fsp.stat(result.filePaths[0]);
      if (stat.size > 2 * 1024 * 1024) return { ok: false, error: 'The settings file is too large (maximum 2 MB).' };
      const obj = JSON.parse(await fsp.readFile(result.filePaths[0], 'utf8'));
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'The settings file must contain a JSON object.' };
      const imported = obj.settings && typeof obj.settings === 'object' && !Array.isArray(obj.settings) ? obj.settings : obj;
      let applied = 0;
      for (const [key, value] of Object.entries(imported)) {
        if (!settingValueError(key, value)) { state.settings[key] = value; applied += 1; }
      }
      persistSettings();
      let bookmarksImported = 0;
      if (Array.isArray(obj.bookmarks)) {
        const deduplicated = new Map();
        for (const item of obj.bookmarks.slice(0, 10000)) {
          if (!item || typeof item !== 'object') continue;
          const url = safeUrl(item.url);
          if (!url || deduplicated.has(url)) continue;
          deduplicated.set(url, { id: crypto.randomUUID(), url, title: String(item.title || url).slice(0, 200), createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now() });
        }
        state.bookmarks = [...deduplicated.values()];
        persistBookmarks();
        bookmarksImported = state.bookmarks.length;
      }
      emitState(); state.window?.webContents.send('settings:changed', state.settings);
      return { ok: true, applied, bookmarksImported, settings: state.settings };
    } catch (error) {
      return { ok: false, error: `Could not import settings: ${String(error.message || error).slice(0, 300)}` };
    }
  });
  ipcMain.handle('browser:resolve-input', (_event, input) => resolveInput(input, state.settings, ENGINES, state.bangIndex));
  ipcMain.handle('browser:navigate', (_event, tabId, url, metadata) => navigateTab(tabId, url, metadata || {}));
  ipcMain.handle('browser:internal', (_event, route) => ({ ok: true, tabId: openInternal(route) }));
  ipcMain.handle('browser:new-tab', (_event, options = {}) => {
    const tab = createTab({ route: 'newtab', background: typeof options.background === 'boolean' ? options.background : null });
    if (options.url) navigateTab(tab.id, options.url);
    return { ok: true, tabId: tab.id };
  });
  ipcMain.handle('browser:activate-tab', (_event, tabId) => { activateTab(tabId); return { ok: true }; });
  ipcMain.handle('browser:close-tab', (_event, tabId) => { closeTab(tabId); return { ok: true }; });
  ipcMain.handle('browser:back', (_event, tabId) => { const tab = state.tabs.get(tabId); if (tab && tab.view.webContents.canGoBack()) tab.view.webContents.goBack(); return { ok: true }; });
  ipcMain.handle('browser:forward', (_event, tabId) => { const tab = state.tabs.get(tabId); if (tab && tab.view.webContents.canGoForward()) tab.view.webContents.goForward(); return { ok: true }; });
  ipcMain.handle('browser:reload', (_event, tabId) => { const tab = state.tabs.get(tabId); if (tab && !tab.route) tab.view.webContents.reload(); return { ok: true }; });
  ipcMain.handle('browser:home', (_event, tabId) => { const tab = state.tabs.get(tabId); const home = safeUrl(state.settings.homepageUrl) || 'https://duckduckgo.com'; if (tab) return navigateTab(tabId, home); return { ok: false }; });
  ipcMain.handle('browser:bookmark-toggle', (_event, tabId) => { const tab = state.tabs.get(tabId); if (!tab || tab.route) return { ok: false, error: 'Only web pages can be bookmarked.' }; return addBookmark(tab.view.webContents.getURL(), tab.title); });
  ipcMain.handle('browser:reopen-closed', () => {
    const item = state.closedTabs.pop();
    if (!item || !safeUrl(item.url)) return { ok: false };
    const tab = createTab({ url: item.url });
    return { ok: true, tabId: tab.id };
  });
  ipcMain.handle('browser:set-view-layout', (_event, tabId, rect) => { applyBounds(tabId, rect); return { ok: true }; });
  ipcMain.handle('browser:set-view-mode', (_event, tabId, mode) => { const tab = state.tabs.get(tabId); if (!tab) return { ok: false }; tab.wantsWebView = mode === 'web'; if (mode === 'web') tab.route = null; updateViewVisibility(); return { ok: true }; });
  ipcMain.handle('browser:set-zoom', (_event, tabId, factor) => { const tab = state.tabs.get(tabId); if (tab && Number.isFinite(factor)) tab.view.webContents.setZoomFactor(Math.min(2, Math.max(0.5, factor))); return { ok: true }; });
  ipcMain.handle('history:get', () => state.history.slice().reverse());
  ipcMain.handle('history:clear', () => { state.history = []; persistHistory(); emitState(); return { ok: true }; });
  ipcMain.handle('bookmarks:get', () => state.bookmarks);
  ipcMain.handle('bookmarks:add', (_event, url, title) => addBookmark(url, title));
  ipcMain.handle('bookmarks:remove', (_event, id) => { state.bookmarks = state.bookmarks.filter(item => item.id !== id && item.url !== id); persistBookmarks(); emitState(); return { ok: true }; });
  ipcMain.handle('downloads:get', () => state.downloads);
  ipcMain.handle('downloads:open-folder', async () => { const dir = state.settings.downloadDirectory && state.settings.downloadDirectory.trim() ? path.resolve(state.settings.downloadDirectory.trim()) : app.getPath('downloads'); await fsp.mkdir(dir, { recursive: true }); await shell.openPath(dir); return { ok: true }; });
  ipcMain.handle('downloads:clear', () => { state.downloads = []; persistDownloads(); state.window?.webContents.send('downloads:changed', state.downloads); return { ok: true }; });
  ipcMain.handle('commands:search', (_event, query, limit) => searchBangs(state.bangIndex, query, Math.min(50, Math.max(1, Number(limit) || 12))));
  ipcMain.handle('commands:list', (_event, options = {}) => {
    const items = state.bangIndex.items;
    const query = String(options.query || '').trim().toLowerCase();
    const category = String(options.category || '').trim();
    const filtered = items.filter(item => (!query || `${item.t} ${item.s} ${item.d} ${item.c}`.toLowerCase().includes(query)) && (!category || item.c === category));
    return { total: items.length, items: filtered.slice(0, Math.min(500, Math.max(1, Number(options.limit) || 200))) };
  });
  ipcMain.handle('commands:add-custom', (_event, payload = {}) => {
    const item = normalizeCustomBang(payload);
    if (!item) return { ok: false, error: 'Enter a shortcut such as !docs and an HTTP(S) URL template containing {query}.' };
    const key = item.t.toLowerCase();
    const existingIndex = state.customBangItems.findIndex(row => row.t.toLowerCase() === key);
    if (existingIndex >= 0) state.customBangItems.splice(existingIndex, 1);
    if (state.customBangItems.length >= 5000) return { ok: false, error: 'The custom shortcut limit is 5,000.' };
    state.customBangItems.unshift(item);
    persistCustomBangs();
    emitState();
    return { ok: true, count: state.customBangItems.length, command: item.t };
  });
  ipcMain.handle('commands:remove-custom', (_event, command) => {
    const key = String(command || '').trim().toLowerCase();
    const before = state.customBangItems.length;
    state.customBangItems = state.customBangItems.filter(item => item.t.toLowerCase() !== key);
    if (state.customBangItems.length === before) return { ok: false, error: 'That custom shortcut was not found.' };
    persistCustomBangs();
    emitState();
    return { ok: true, count: state.customBangItems.length };
  });
  ipcMain.handle('commands:export-custom', async () => {
    const result = await dialog.showSaveDialog(state.window, { title: 'Export Lithium custom shortcuts', defaultPath: 'lithium-custom-shortcuts.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    await fsp.writeFile(result.filePath, JSON.stringify({ version: VERSION, commands: state.customBangItems }, null, 2), 'utf8');
    return { ok: true, count: state.customBangItems.length };
  });
  ipcMain.handle('commands:import-custom', async () => {
    const result = await dialog.showOpenDialog(state.window, { title: 'Import Lithium custom shortcuts', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    try {
      const stat = await fsp.stat(result.filePaths[0]);
      if (stat.size > 5 * 1024 * 1024) return { ok: false, error: 'The shortcut file is too large (maximum 5 MB).' };
      const parsed = JSON.parse(await fsp.readFile(result.filePaths[0], 'utf8'));
      const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? parsed.commands : null;
      if (!Array.isArray(rows)) return { ok: false, error: 'The file must contain a commands array.' };
      const imported = normalizeCustomBangList(rows, 5000);
      if (!imported.length) return { ok: false, error: 'No valid custom shortcuts were found. Existing commands were kept.' };
      // Imported entries override existing aliases with the same key, without
      // discarding unrelated personal shortcuts.
      state.customBangItems = normalizeCustomBangList([...state.customBangItems, ...imported], 5000);
      persistCustomBangs();
      emitState();
      return { ok: true, count: state.customBangItems.length, imported: imported.length };
    } catch (error) {
      return { ok: false, error: `Could not import shortcuts: ${String(error.message || error).slice(0, 300)}` };
    }
  });
  ipcMain.handle('commands:refresh', async () => {
    try {
      const response = await net.fetch('https://duckduckgo.com/bang.js', { headers: { 'User-Agent': `LithiumBrowser-BangLibrary/${VERSION}` }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('Unexpected source format');
      const byKey = new Map();
      for (const item of rows) {
        if (!item || typeof item.t !== 'string' || typeof item.u !== 'string' || !/^![^\s!]+$/.test(item.t.trim()) || !isSafeBangTemplate(item.u)) continue;
        const command = item.t.trim();
        const key = command.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, { t: command, s: String(item.s || command).slice(0, 300), d: String(item.d || '').slice(0, 300), u: item.u.slice(0, 4096), c: String(item.c || 'Other').slice(0, 100) });
      }
      if (byKey.size < 3000) throw new Error(`Only ${byKey.size} commands validated; keeping current library.`);
      state.bangItems = [...byKey.values()]; rebuildBangIndex();
      writeJsonFile(userFile('bangs.json'), state.bangItems);
      emitState();
      return { ok: true, count: state.bangIndex.items.length };
    } catch (error) { return { ok: false, error: error.message, count: state.bangIndex.items.length }; }
  });
  ipcMain.handle('window:control', (_event, action) => { handleWindowControl(action); return { ok: true }; });
  ipcMain.handle('window:maximized', () => Boolean(state.window && state.window.isMaximized()));
  ipcMain.handle('app:open-external', async (_event, url) => { const valid = safeUrl(url); if (!valid) return { ok: false }; await shell.openExternal(valid); return { ok: true }; });
  ipcMain.handle('app:export-diagnostics', async () => {
    const report = { app: APP_NAME, version: VERSION, electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, settingsAvailable: CATALOG.filter(s => s.status === 'available').length, settingsTotal: CATALOG.length, bangCount: state.bangIndex.items.length, tabCount: state.tabs.size, telemetry: false, generatedAt: new Date().toISOString() };
    const result = await dialog.showSaveDialog(state.window, { title: 'Export Lithium diagnostics', defaultPath: 'lithium-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    await fsp.writeFile(result.filePath, JSON.stringify(report, null, 2), 'utf8');
    return { ok: true, path: result.filePath };
  });
}

function createWindow() {
  const remembered = state.settings.rememberWindowBounds && state.windowBounds ? state.windowBounds : { width: 1460, height: 930 };
  state.window = new BrowserWindow({
    width: remembered.width, height: remembered.height, minWidth: 900, minHeight: 620,
    frame: false, show: false, backgroundColor: '#11131a', autoHideMenuBar: true,
    title: 'Lithium Browser',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false },
  });
  state.window.once('ready-to-show', () => state.window.show());
  // Re-parent existing tab views if macOS recreates the main window after it was closed.
  for (const tab of state.tabs.values()) {
    try {
      if (tab.attachedWindow !== state.window) {
        if (tab.attachedWindow && !tab.attachedWindow.isDestroyed()) tab.attachedWindow.contentView.removeChildView(tab.view);
        state.window.contentView.addChildView(tab.view);
        tab.attachedWindow = state.window;
      }
    } catch (error) {
      console.error('Could not reattach an existing Lithium tab:', error);
    }
  }
  state.window.loadFile(path.join(ROOT, 'src', 'index.html'));
  state.window.on('maximize', () => state.window.webContents.send('window:maximized-changed', true));
  state.window.on('unmaximize', () => state.window.webContents.send('window:maximized-changed', false));
  state.window.on('close', event => {
    if (state.quitting) return;
    const shouldPrompt = state.settings.warnOnQuit === true || (state.settings.confirmCloseMultipleTabs === true && state.tabs.size > 1);
    if (!shouldPrompt) return;
    const response = dialog.showMessageBoxSync(state.window, { type: 'question', buttons: ['Quit Lithium', 'Cancel'], defaultId: 1, cancelId: 1, message: state.tabs.size > 1 ? `You have ${state.tabs.size} tabs open. Quit Lithium?` : 'Quit Lithium?' });
    if (response !== 0) event.preventDefault();
  });
  state.window.on('closed', () => { state.window = null; });
}

async function cleanupOnExit() {
  if (state.settings.clearHistoryOnExit) { state.history = []; try { persistHistory(); } catch {} }
  if (state.settings.autoClearDownloadHistoryOnExit) { state.downloads = []; try { persistDownloads(); } catch {} }
  if (!state.browserSession) return;
  const tasks = [];
  if (state.settings.clearCookiesOnExit) tasks.push(state.browserSession.clearStorageData({ storages: ['cookies'] }));
  if (state.settings.clearCacheOnExit) tasks.push(state.browserSession.clearCache());
  if (state.settings.clearSiteDataOnExit) tasks.push(state.browserSession.clearStorageData());
  await Promise.allSettled(tasks);
}

try {
  const startupSettings = readJsonFile(path.join(app.getPath('userData'), 'settings.json'), {});
  if (startupSettings.hardwareAcceleration === false) app.disableHardwareAcceleration();
} catch {}

app.whenReady().then(async () => {
  loadPersistentState();
  state.browserSession = session.fromPartition('persist:lithium-browser');
  await configureSession(state.browserSession);
  registerIpc();
  createWindow();
  const shouldRestoreSession = state.settings.startupBehavior === 'restore' || state.settings.restoreLastSession === true;
  const lastSessionData = shouldRestoreSession ? readJsonFile(userFile('last-session.json'), []) : [];
  const restored = Array.isArray(lastSessionData) ? lastSessionData : (Array.isArray(lastSessionData.tabs) ? lastSessionData.tabs : []);
  if (restored.length) {
    for (const item of restored.slice(0, 30)) if (safeUrl(item.url)) createTab({ url: item.url, background: state.tabs.size > 0 });
    if (state.tabs.size) {
      const desiredUrl = !Array.isArray(lastSessionData) && state.settings.rememberLastActiveTab ? lastSessionData.activeUrl : null;
      const matched = desiredUrl ? [...state.tabs.values()].find(tab => tab.view.webContents.getURL() === desiredUrl) : null;
      state.activeTabId = matched ? matched.id : [...state.tabs.keys()][0];
    } else createTab({ route: 'newtab' });
  } else if (state.settings.startupBehavior === 'homepage') {
    createTab({ url: safeUrl(state.settings.homepageUrl) || 'https://duckduckgo.com' });
  } else {
    createTab({ route: 'newtab' });
  }
  emitState();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { createWindow(); if (!state.tabs.size) createTab({ route: 'newtab' }); } });
}).catch(error => {
  console.error('Lithium failed to initialize:', error);
  app.quit();
});

app.on('before-quit', event => {
  if (state.quitting) return;
  event.preventDefault();
  state.quitting = true;
  const openTabs = [...state.tabs.values()].filter(tab => !tab.route).map(tab => ({ url: safeUrl(tab.view.webContents.getURL()), title: tab.title })).filter(item => item.url);
  const active = state.tabs.get(state.activeTabId);
  try {
    writeJsonFile(userFile('last-session.json'), state.settings.closeTabsOnExit ? { tabs: [], activeUrl: null } : { tabs: openTabs, activeUrl: state.settings.rememberLastActiveTab && active ? safeUrl(active.view.webContents.getURL()) : null });
    if (state.settings.rememberWindowBounds && state.window && !state.window.isMaximized()) { const bounds = state.window.getBounds(); writeJsonFile(userFile('window-bounds.json'), { width: bounds.width, height: bounds.height }); }
  } catch {}
  cleanupOnExit().finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
