'use strict';

// ---------------------------------------------------------------------------
// Resilience guard: if Electron is launched in "run as Node" mode
// (ELECTRON_RUN_AS_NODE=1), the GUI APIs are undefined and the app would crash.
// Detect it and re-launch the real Electron runtime with a clean environment.
// ---------------------------------------------------------------------------
const electron = require('electron');
if (typeof electron === 'string') {
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__dirname, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
  child.on('close', (code) => process.exit(code ?? 0));
  return;
}

const { app, BaseWindow, WebContentsView, ipcMain, Menu, dialog, session, webContents } = electron;
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const fetch = require('cross-fetch');
const { ElectronBlocker, fromElectronDetails, Request } = require('@ghostery/adblocker-electron');

const CHROME_BASE = 84; // tab strip + toolbar
const FIND_BAR_HEIGHT = 44;
const UI_DIR = path.join(__dirname, 'ui');
const START_PAGE = pathToFileURL(path.join(UI_DIR, 'home.html')).href;

const windows = new Set();

// ---------------------------------------------------------------------------
// Internal "nova://" pages. These are local HTML files in ui/ surfaced under a
// friendly pseudo-scheme so the omnibox shows `nova://settings` instead of a
// long file:// path. novaToFile() resolves a page name to its file URL;
// fileToNova() is the reverse, used to pretty-print the address bar.
// ---------------------------------------------------------------------------
const INTERNAL_PAGES = ['settings', 'adblock', 'extensions', 'history', 'about'];

function novaToFile(page) {
  const name = (page || '').toLowerCase();
  if (name === '' || name === 'home' || name === 'newtab' || name === 'new-tab') return START_PAGE;
  if (INTERNAL_PAGES.includes(name)) return pathToFileURL(path.join(UI_DIR, name + '.html')).href;
  return null;
}

function fileToNova(url) {
  if (!url) return null;
  for (const name of INTERNAL_PAGES) {
    const fileUrl = pathToFileURL(path.join(UI_DIR, name + '.html')).href;
    if (url === fileUrl || url.startsWith(fileUrl + '#') || url.startsWith(fileUrl + '?')) {
      return 'nova://' + name;
    }
  }
  return null;
}

function isInternalUrl(url) {
  return !!url && (url.startsWith(START_PAGE) || !!fileToNova(url));
}

// ---------------------------------------------------------------------------
// User settings, persisted to userData/nova-settings.json and edited from the
// nova://settings page. A handful are wired into real behaviour below
// (search engine -> normalizeInput, home page -> home()).
// ---------------------------------------------------------------------------
const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
};
const DEFAULT_SETTINGS = {
  searchEngine: 'google',
  homepage: 'nova', // 'nova' (start page) or 'custom'
  homepageUrl: '',
  reduceMotion: false,
  adBlock: true, // built-in ad & tracker blocker (EasyList / EasyPrivacy)
  adBlockCosmetics: true, // hide ad containers + run scriptlets (needed for YouTube-style ads)
  adBlockLevel: 'standard', // 'standard' (ads + tracking) or 'complete' (+ annoyances)
  adBlockAllowlist: [], // hostnames where blocking is disabled
  extensions: [], // [{ path, enabled }] — real unpacked Chrome extensions
};
const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

function settingsFile() { return path.join(app.getPath('userData'), 'nova-settings.json'); }
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); }
  catch { /* first run / unreadable — keep defaults */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); }
  catch (e) { console.error('[settings] save failed:', e.message); }
}
function searchUrl(query) {
  return (SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.google) + encodeURIComponent(query);
}
function homepageUrl() {
  if (settings.homepage === 'custom' && settings.homepageUrl.trim()) {
    return normalizeInput(settings.homepageUrl);
  }
  return START_PAGE;
}

// ---------------------------------------------------------------------------
// Extension manager. nova://extensions loads/unloads *real* unpacked Chrome
// extensions into the default session (the one tab views use), via Electron's
// session.loadExtension. The managed list is persisted in settings.extensions
// and reloaded on startup. Enable/disable maps to load/remove.
// ---------------------------------------------------------------------------
const loadedExt = new Map(); // path -> { id, name, version, error }

async function loadOneExtension(extPath) {
  try {
    const ext = await session.defaultSession.loadExtension(extPath, { allowFileAccess: true });
    loadedExt.set(extPath, { id: ext.id, name: ext.name, version: ext.version, error: null });
  } catch (e) {
    loadedExt.set(extPath, { id: null, name: path.basename(extPath), version: '', error: e.message });
  }
  return loadedExt.get(extPath);
}
function unloadOneExtension(extPath) {
  const info = loadedExt.get(extPath);
  if (info && info.id) { try { session.defaultSession.removeExtension(info.id); } catch { /* already gone */ } }
  loadedExt.delete(extPath);
}
async function initExtensions() {
  if (!Array.isArray(settings.extensions)) settings.extensions = [];
  for (const e of settings.extensions) if (e.enabled) await loadOneExtension(e.path);
}
function extList() {
  return (settings.extensions || []).map((e) => {
    const live = loadedExt.get(e.path);
    return {
      path: e.path,
      enabled: !!e.enabled,
      name: (live && live.name) || path.basename(e.path),
      version: (live && live.version) || '',
      error: live ? live.error : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Built-in ad & tracker blocker. Uses the Ghostery/Cliqz engine with the same
// EasyList + EasyPrivacy filter lists that power Adblock Plus, applied at the
// network layer (plus cosmetic hiding) on the default session every tab uses.
// The compiled engine is cached to disk so it works offline after first run.
// ---------------------------------------------------------------------------
let blocker = null;
let blockedCount = 0;
let netRegistered = false;

function adblockCachePath(level) {
  return path.join(app.getPath('userData'), `adblock-${level}.bin`);
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
function isAllowlisted(host) {
  if (!host) return false;
  return settings.adBlockAllowlist.some((d) => host === d || host.endsWith('.' + d));
}

// Build (or rebuild) the filter engine for the current level, caching the
// compiled engine per-level so it loads instantly and works offline next time.
async function initEngine() {
  const level = settings.adBlockLevel === 'complete' ? 'complete' : 'standard';
  const caching = {
    path: adblockCachePath(level),
    read: (p) => fs.promises.readFile(p),
    write: (p, data) => fs.promises.writeFile(p, data),
  };
  blocker = level === 'complete'
    ? await ElectronBlocker.fromPrebuiltFull(fetch, caching)
    : await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, caching);
  if (!netRegistered) { registerNetworkBlocking(); netRegistered = true; }
}

// Network-level blocking via webRequest. (The library's enableBlockingInSession
// needs a newer Electron session API than v31 ships, so we drive the engine's
// matcher directly — this stops ads/trackers from ever loading.)
function registerNetworkBlocking() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!settings.adBlock || !blocker) return callback({});
    const wc = details.webContentsId != null ? webContents.fromId(details.webContentsId) : null;
    const pageHost = hostOf(wc ? wc.getURL() : (details.referrer || details.url));
    if (isAllowlisted(pageHost)) return callback({});
    let request;
    try { request = fromElectronDetails(details); } catch { return callback({}); }
    if (!request || !request.isSupported) return callback({});
    const { match, redirect } = blocker.match(request);
    if (redirect && redirect.dataUrl) { blockedCount++; return callback({ redirectURL: redirect.dataUrl }); }
    if (match) { blockedCount++; return callback({ cancel: true }); }
    callback({});
  });
}

// Cosmetic filtering: hide ad containers (CSS) and run scriptlets in the page.
// This is what network blocking can't do — e.g. same-origin ads (YouTube) and
// empty ad slots. Injected on each main-frame load; allowlisted sites skip it.
function injectCosmetics(wc, url) {
  if (!blocker || !settings.adBlock || !settings.adBlockCosmetics) return;
  if (!/^https?:/.test(url || '')) return;
  if (isAllowlisted(hostOf(url))) return;
  let res;
  try {
    const req = Request.fromRawDetails({ url, type: 'document', sourceUrl: url });
    res = blocker.getCosmeticsFilters({ url, hostname: req.hostname, domain: req.domain, getRulesFromDOM: false });
  } catch { return; }
  if (res.styles) wc.insertCSS(res.styles, { cssOrigin: 'user' }).catch(() => {});
  for (const script of res.scripts || []) {
    // Each scriptlet runs on its own so one that throws can't block the others.
    wc.executeJavaScript(script, true).catch(() => {});
  }
}

function adblockState() {
  return {
    enabled: settings.adBlock,
    cosmetics: settings.adBlockCosmetics,
    level: settings.adBlockLevel,
    blocked: blockedCount,
    allowlist: [...settings.adBlockAllowlist],
    ready: !!blocker,
  };
}

function applyAdBlock() {
  // On/off is read live inside the webRequest callback, so nothing to do here.
}

// In-memory browsing history (newest last), shared across windows.
const history = [];
const HISTORY_LIMIT = 1000;
function recordHistory(url, title) {
  if (!url || isInternalUrl(url) || /^(view-source|data|chrome|about):/.test(url)) return;
  const last = history[history.length - 1];
  if (last && last.url === url) { last.time = Date.now(); if (title) last.title = title; return; }
  history.push({ url, title: title || url, time: Date.now() });
  if (history.length > HISTORY_LIMIT) history.shift();
}

// ---- Version-safe navigation helpers (Electron's navigationHistory API
// gained canGoBack/goBack methods only in newer versions). ----
function navCanGoBack(wc) {
  const h = wc.navigationHistory;
  return h && typeof h.canGoBack === 'function' ? h.canGoBack() : wc.canGoBack();
}
function navCanGoForward(wc) {
  const h = wc.navigationHistory;
  return h && typeof h.canGoForward === 'function' ? h.canGoForward() : wc.canGoForward();
}
function navGoBack(wc) {
  const h = wc.navigationHistory;
  if (h && typeof h.goBack === 'function') h.goBack();
  else wc.goBack();
}
function navGoForward(wc) {
  const h = wc.navigationHistory;
  if (h && typeof h.goForward === 'function') h.goForward();
  else wc.goForward();
}

function normalizeInput(input) {
  const value = (input || '').trim();
  if (!value) return START_PAGE;
  const nova = value.match(/^nova:\/\/([a-z-]*)\/?$/i);
  if (nova) return novaToFile(nova[1]) || START_PAGE;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return value;
  if (/^(about|chrome|file|data|view-source):/.test(value)) return value;
  if (/^[^\s]+\.[^\s]+$/.test(value) && !value.includes(' ')) return 'https://' + value;
  return searchUrl(value);
}

// ===========================================================================
// One browser window: its own chrome UI, tab set, and find bar.
// ===========================================================================
class BrowserWin {
  constructor() {
    this.tabs = new Map(); // id -> { view, url, title, canGoBack, canGoForward, loading }
    this.activeTabId = null;
    this.nextTabId = 1;
    this.closedStack = []; // URLs of recently closed tabs (for reopen)
    this.findOpen = false;

    this.baseWindow = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 520,
      minHeight: 380,
      title: 'Nova',
      backgroundColor: '#0a0e27',
      // Merge the chrome with the window: hide the native title bar so the tab
      // strip sits at the very top. On macOS the traffic lights stay, inset
      // into the tab strip; the strip itself is the drag region (see CSS).
      // (Only on macOS, where the traffic lights remain usable. Other platforms
      // keep their native frame since Nova has no custom window controls.)
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 15, y: 13 } }
        : {}),
    });

    this.chromeView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.forwardConsole(this.chromeView.webContents, 'chrome');
    this.attachShortcuts(this.chromeView.webContents, true);
    this.baseWindow.contentView.addChildView(this.chromeView);
    this.chromeView.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));

    this.chromeView.webContents.on('did-finish-load', () => {
      if (this.tabs.size === 0) this.createTab(START_PAGE);
    });

    this.layout();
    this.baseWindow.on('resize', () => this.layout());

    // Forward find results to the chrome UI.
    this._findHandlers = new WeakSet();

    this.baseWindow.on('closed', () => windows.delete(this));
    windows.add(this);
  }

  forwardConsole(wc, label) {
    wc.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 3) console.error(`[${label}] ${message}  (${sourceId}:${line})`);
    });
    wc.on('render-process-gone', (_e, d) => console.error(`[${label}] gone:`, d.reason));
  }

  chromeHeight() {
    return CHROME_BASE + (this.findOpen ? FIND_BAR_HEIGHT : 0);
  }

  layout() {
    if (this.baseWindow.isDestroyed()) return;
    const { width, height } = this.baseWindow.getContentBounds();
    const ch = this.chromeHeight();
    this.chromeView.setBounds({ x: 0, y: 0, width, height: ch });
    const tab = this.tabs.get(this.activeTabId);
    if (tab) tab.view.setBounds({ x: 0, y: ch, width, height: Math.max(0, height - ch) });
  }

  send(channel, payload) {
    if (!this.chromeView.webContents.isDestroyed()) {
      this.chromeView.webContents.send(channel, payload);
    }
  }

  displayUrl(url) {
    if (!url || url.startsWith(START_PAGE)) return '';
    return fileToNova(url) || url;
  }

  sendTabState(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.send('tab:state', {
      id,
      url: this.displayUrl(tab.url),
      title: tab.title,
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      active: id === this.activeTabId,
    });
  }

  createTab(url) {
    const id = this.nextTabId++;
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A guarded bridge: nova-preload only exposes window.nova on our own
        // internal pages, so regular sites can never read history or versions.
        preload: path.join(__dirname, 'nova-preload.js'),
      },
    });
    const wc = view.webContents;
    const tab = { view, url: url || START_PAGE, title: 'New Tab', canGoBack: false, canGoForward: false, loading: false };
    this.tabs.set(id, tab);
    this.forwardConsole(wc, `tab ${id}`);
    this.attachShortcuts(wc, false);

    const refresh = () => {
      tab.url = wc.getURL() || tab.url;
      tab.canGoBack = navCanGoBack(wc);
      tab.canGoForward = navCanGoForward(wc);
      recordHistory(tab.url, tab.title);
      this.sendTabState(id);
    };
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      recordHistory(tab.url, title);
      this.sendTabState(id);
    });
    wc.on('did-start-loading', () => { tab.loading = true; this.sendTabState(id); });
    wc.on('did-stop-loading', () => { tab.loading = false; refresh(); });
    wc.on('did-navigate', refresh);
    wc.on('did-navigate-in-page', refresh);
    // Apply cosmetic filters once the document exists, and again on SPA navigations.
    wc.on('dom-ready', () => injectCosmetics(wc, wc.getURL()));
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) injectCosmetics(wc, url); });
    wc.on('page-favicon-updated', (_e, favs) => this.send('tab:favicon', { id, favicon: favs[0] || null }));
    wc.on('found-in-page', (_e, result) =>
      this.send('find:result', { active: result.activeMatchOrdinal, matches: result.matches }));
    wc.setWindowOpenHandler(({ url: u }) => { this.createTab(u); return { action: 'deny' }; });

    this.baseWindow.contentView.addChildView(view);
    wc.loadURL(tab.url);
    this.setActiveTab(id);
    this.send('tab:created', { id, url: this.displayUrl(tab.url), title: tab.title });
    return id;
  }

  setActiveTab(id) {
    if (!this.tabs.has(id)) return;
    this.activeTabId = id;
    for (const [tid, t] of this.tabs) t.view.setVisible(tid === id);
    if (this.findOpen) this.closeFind();
    this.layout();
    this.send('tab:activated', { id });
    this.sendTabState(id);
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const url = tab.view.webContents.getURL();
    if (url && !url.startsWith(START_PAGE)) this.closedStack.push(url);
    this.baseWindow.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(id);
    this.send('tab:closed', { id });

    if (this.activeTabId === id) {
      const remaining = [...this.tabs.keys()];
      if (remaining.length) this.setActiveTab(remaining[remaining.length - 1]);
      else { this.activeTabId = null; this.createTab(START_PAGE); }
    }
  }

  reopenClosedTab() {
    const url = this.closedStack.pop();
    if (url) this.createTab(url);
    else this.createTab(START_PAGE);
  }

  activeWC() {
    const tab = this.tabs.get(this.activeTabId);
    return tab ? tab.view.webContents : null;
  }

  tabIds() { return [...this.tabs.keys()]; }

  selectIndex(i) { const ids = this.tabIds(); if (ids[i] != null) this.setActiveTab(ids[i]); }
  selectLast() { const ids = this.tabIds(); if (ids.length) this.setActiveTab(ids[ids.length - 1]); }
  cycleTab(dir) {
    const ids = this.tabIds();
    if (ids.length < 2) return;
    const cur = ids.indexOf(this.activeTabId);
    const next = (cur + dir + ids.length) % ids.length;
    this.setActiveTab(ids[next]);
  }

  navigate(input) { const wc = this.activeWC(); if (wc) wc.loadURL(normalizeInput(input)); }
  back() { const wc = this.activeWC(); if (wc && navCanGoBack(wc)) navGoBack(wc); }
  forward() { const wc = this.activeWC(); if (wc && navCanGoForward(wc)) navGoForward(wc); }
  reload() { const wc = this.activeWC(); if (wc) wc.reload(); }
  forceReload() { const wc = this.activeWC(); if (wc) wc.reloadIgnoringCache(); }
  stop() { const wc = this.activeWC(); if (wc) wc.stop(); }
  home() { const wc = this.activeWC(); if (wc) wc.loadURL(homepageUrl()); }

  // Native overflow menu. A DOM dropdown can't be used here: the chrome UI is a
  // fixed-height WebContentsView, so anything drawn below the toolbar is clipped
  // and hidden behind the page. A native popup escapes those bounds.
  popupAppMenu(pos = {}) {
    const menu = Menu.buildFromTemplate([
      { label: 'New Tab', click: () => this.createTab(START_PAGE) },
      { type: 'separator' },
      { label: 'Settings', click: () => this.openInternal('settings') },
      { label: 'Ad Blocker', click: () => this.openInternal('adblock') },
      { label: 'Extensions', click: () => this.openInternal('extensions') },
      { label: 'History', click: () => this.openInternal('history') },
      { type: 'separator' },
      { label: 'About Nova', click: () => this.openInternal('about') },
    ]);
    const opts = { window: this.baseWindow };
    if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      opts.x = Math.round(pos.x);
      opts.y = Math.round(pos.y);
    }
    menu.popup(opts);
  }

  // Open an internal nova:// page. If a tab already shows it, focus that tab;
  // otherwise open it in a new tab so the current page isn't lost.
  openInternal(page) {
    const url = novaToFile(page) || START_PAGE;
    for (const [id, t] of this.tabs) {
      if (t.view.webContents.getURL() === url) { this.setActiveTab(id); return; }
    }
    this.createTab(url);
  }

  zoom(delta) {
    const wc = this.activeWC();
    if (!wc) return;
    const lvl = delta === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta));
    wc.setZoomLevel(lvl);
  }

  toggleDevTools() {
    const wc = this.activeWC();
    if (!wc) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'right' });
  }

  toggleFullScreen() { this.baseWindow.setFullScreen(!this.baseWindow.isFullScreen()); }

  print() { const wc = this.activeWC(); if (wc) wc.print(); }

  viewSource() {
    const wc = this.activeWC();
    if (wc) this.createTab('view-source:' + wc.getURL());
  }

  focusAddressBar() { this.chromeView.webContents.focus(); this.send('focus-omnibox'); }

  // ---- Find in page ----
  openFind() { this.findOpen = true; this.layout(); this.send('find:open'); }
  closeFind() {
    this.findOpen = false;
    const wc = this.activeWC();
    if (wc) wc.stopFindInPage('clearSelection');
    this.layout();
    this.send('find:close');
  }
  find(text, forward, findNext) {
    const wc = this.activeWC();
    if (wc && text) wc.findInPage(text, { forward, findNext });
  }
  findNext(forward) {
    const wc = this.activeWC();
    if (wc) this.send('find:repeat', { forward });
  }

  // ---- Keyboard shortcuts (work regardless of focus) ----
  attachShortcuts(wc, isChrome) {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const mac = process.platform === 'darwin';
      const mod = mac ? input.meta : input.control; // CmdOrCtrl
      const ctrl = input.control, shift = input.shift, alt = input.alt;
      const k = input.key.length === 1 ? input.key.toLowerCase() : input.key;
      const stop = () => event.preventDefault();

      // --- Mod (Cmd/Ctrl) combos ---
      if (mod && !alt) {
        if (k === 't' && !shift) return (this.createTab(START_PAGE), stop());
        if (k === 't' && shift) return (this.reopenClosedTab(), stop());
        if (k === 'w' && !shift) return (this.closeTab(this.activeTabId), stop());
        if (k === 'w' && shift) return (this.baseWindow.close(), stop());
        if (k === 'n' && !shift) return (new BrowserWin(), stop());
        if (k === 'r') return (shift ? this.forceReload() : this.reload(), stop());
        if (k === 'l') return (this.focusAddressBar(), stop());
        if (k === 'f' && !shift) return (this.openFind(), stop());
        if (k === 'g') return (this.findNext(!shift), stop());
        if (k === 'p') return (this.print(), stop());
        if (k === 'u') return (this.viewSource(), stop());
        if (k === 'h' && shift) return (this.home(), stop());
        if (k === ',') return (this.openInternal('settings'), stop());
        if (k === 'y' && !shift) return (this.openInternal('history'), stop());
        if (k === 'e' && shift) return (this.openInternal('extensions'), stop());
        if (k === 'b' && shift) return (this.openInternal('adblock'), stop());
        if (k === '0') return (this.zoom(0), stop());
        if (k === '=' || k === '+') return (this.zoom(0.5), stop());
        if (k === '-' || k === '_') return (this.zoom(-0.5), stop());
        if (input.key.length === 1 && k >= '1' && k <= '8') return (this.selectIndex(Number(k) - 1), stop());
        if (k === '9') return (this.selectLast(), stop());
        if (k === '[') return (this.back(), stop());
        if (k === ']') return (this.forward(), stop());
        // Cmd+Arrow navigation/word-nav: only treat as Back/Forward outside the omnibox.
        if (mac && !isChrome && k === 'ArrowLeft') return (this.back(), stop());
        if (mac && !isChrome && k === 'ArrowRight') return (this.forward(), stop());
      }

      // --- Mac tab cycling: Cmd+Option+Arrow ---
      if (mac && input.meta && alt) {
        if (k === 'ArrowRight') return (this.cycleTab(1), stop());
        if (k === 'ArrowLeft') return (this.cycleTab(-1), stop());
      }

      // --- Ctrl combos (cross-platform, even on mac) ---
      if (ctrl) {
        if (k === 'Tab') return (this.cycleTab(shift ? -1 : 1), stop());
        if (k === 'PageDown') return (this.cycleTab(1), stop());
        if (k === 'PageUp') return (this.cycleTab(-1), stop());
      }

      // --- Alt+Arrow back/forward (skip in omnibox where it's word-nav) ---
      if (alt && !isChrome) {
        if (k === 'ArrowLeft') return (this.back(), stop());
        if (k === 'ArrowRight') return (this.forward(), stop());
      }
      if (alt && k === 'Home') return (this.home(), stop());
      if (alt && k === 'd') return (this.focusAddressBar(), stop());

      // --- Function keys ---
      if (k === 'F5') return ((shift || ctrl) ? this.forceReload() : this.reload(), stop());
      if (k === 'F6') return (this.focusAddressBar(), stop());
      if (k === 'F11') return (this.toggleFullScreen(), stop());
      if (k === 'F12') return (this.toggleDevTools(), stop());
      if (k === 'F3') return (this.findNext(!shift), stop());

      // DevTools / fullscreen platform variants
      if (mac && alt && input.meta && k === 'i') return (this.toggleDevTools(), stop());
      if (!mac && ctrl && shift && k === 'i') return (this.toggleDevTools(), stop());
      if (mac && ctrl && input.meta && k === 'f') return (this.toggleFullScreen(), stop());

      // Escape: close find if open (don't swallow otherwise — let pages use Esc).
      if (k === 'Escape') {
        if (this.findOpen) { this.closeFind(); stop(); }
        else this.stop();
      }
    });
  }
}

// ===========================================================================
// IPC from the chrome UI -> owning window
// ===========================================================================
function winOf(event) {
  for (const w of windows) {
    if (w.chromeView.webContents === event.sender) return w;
    for (const t of w.tabs.values()) if (t.view.webContents === event.sender) return w;
  }
  return null;
}
const on = (channel, fn) => ipcMain.on(channel, (e, ...a) => { const w = winOf(e); if (w) fn(w, ...a); });

on('action:new-tab', (w, url) => w.createTab(url ? normalizeInput(url) : START_PAGE));
on('action:close-tab', (w, id) => w.closeTab(id));
on('action:activate-tab', (w, id) => w.setActiveTab(id));
on('action:navigate', (w, { id, input }) => {
  if (id != null) w.setActiveTab(id);
  w.navigate(input);
});
on('action:back', (w) => w.back());
on('action:forward', (w) => w.forward());
on('action:reload', (w) => w.reload());
on('action:stop', (w) => w.stop());
on('action:home', (w) => w.home());
on('find:query', (w, { text, forward, findNext }) => w.find(text, forward, findNext));
on('find:close', (w) => w.closeFind());
on('action:app-menu', (w, pos) => w.popupAppMenu(pos));

// ---- Bridge for internal nova:// pages (history, version info) ----
ipcMain.handle('nova:get-history', () => history.slice().reverse());
ipcMain.handle('nova:clear-history', () => { history.length = 0; return true; });
ipcMain.handle('nova:get-settings', () => ({ ...settings }));
ipcMain.handle('nova:set-settings', (_e, patch) => {
  if (patch && typeof patch === 'object') {
    Object.assign(settings, patch);
    saveSettings();
    if ('adBlock' in patch) applyAdBlock();
  }
  return { ...settings };
});
ipcMain.handle('nova:get-blocked-count', () => blockedCount);

// ---- Ad-blocker control panel (nova://adblock) ----
ipcMain.handle('nova:adblock-state', () => adblockState());
ipcMain.handle('nova:adblock-set', async (_e, patch = {}) => {
  if (typeof patch.enabled === 'boolean') settings.adBlock = patch.enabled;
  if (typeof patch.cosmetics === 'boolean') settings.adBlockCosmetics = patch.cosmetics;
  if (patch.resetCount) blockedCount = 0;
  if (patch.allowAdd) {
    const h = String(patch.allowAdd).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (h && !settings.adBlockAllowlist.includes(h)) settings.adBlockAllowlist.push(h);
  }
  if (patch.allowRemove) {
    settings.adBlockAllowlist = settings.adBlockAllowlist.filter((d) => d !== patch.allowRemove);
  }
  let rebuilding = false;
  if (patch.level && patch.level !== settings.adBlockLevel && ['standard', 'complete'].includes(patch.level)) {
    settings.adBlockLevel = patch.level;
    rebuilding = true;
  }
  saveSettings();
  if (rebuilding) { try { await initEngine(); } catch (e) { console.error('[adblock] rebuild failed:', e.message); } }
  return adblockState();
});
ipcMain.handle('nova:reset-settings', () => {
  // Unload any loaded extensions, then restore a fresh copy of the defaults.
  for (const e of settings.extensions || []) unloadOneExtension(e.path);
  Object.assign(settings, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  saveSettings();
  applyAdBlock();
  return { ...settings };
});
ipcMain.handle('nova:list-extensions', () => extList());
ipcMain.handle('nova:add-extension', async (e) => {
  const w = winOf(e);
  const opts = { properties: ['openDirectory'], title: 'Select an unpacked extension folder' };
  const res = await (w ? dialog.showOpenDialog(w.baseWindow, opts) : dialog.showOpenDialog(opts));
  if (res.canceled || !res.filePaths.length) return { canceled: true, list: extList() };
  const extPath = res.filePaths[0];
  let item = settings.extensions.find((x) => x.path === extPath);
  if (!item) { item = { path: extPath, enabled: true }; settings.extensions.push(item); }
  item.enabled = true;
  await loadOneExtension(extPath);
  saveSettings();
  return { list: extList() };
});
ipcMain.handle('nova:set-extension-enabled', async (_e, { path: p, enabled }) => {
  const item = (settings.extensions || []).find((x) => x.path === p);
  if (item) {
    item.enabled = !!enabled;
    if (enabled) await loadOneExtension(p); else unloadOneExtension(p);
    saveSettings();
  }
  return extList();
});
ipcMain.handle('nova:remove-extension', (_e, { path: p }) => {
  unloadOneExtension(p);
  settings.extensions = (settings.extensions || []).filter((x) => x.path !== p);
  saveSettings();
  return extList();
});
ipcMain.handle('nova:get-versions', () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  v8: process.versions.v8,
  platform: `${process.platform} ${process.arch}`,
}));

// ===========================================================================
// Native application menu (gives macOS clipboard shortcuts + discoverability).
// Navigation/tab shortcuts themselves are handled by before-input-event above.
// ===========================================================================
function focusedWin() {
  const bw = BaseWindow.getFocusedWindow();
  for (const w of windows) if (w.baseWindow === bw) return w;
  return [...windows][0] || null;
}
const run = (method, ...args) => () => { const w = focusedWin(); if (w) w[method](...args); };

// Menu items display their shortcut but DON'T register the accelerator
// (registerAccelerator: false) — before-input-event is the single handler,
// which avoids double-firing. Clipboard roles keep their real accelerators.
function item(label, accel, method, ...args) {
  const click = method === 'newWindow'
    ? () => new BrowserWin()
    : method === 'closeActiveTab'
      ? () => { const w = focusedWin(); if (w) w.closeTab(w.activeTabId); }
      : run(method, ...args);
  return { label, accelerator: accel, registerAccelerator: false, click };
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const mod = mac ? 'Cmd' : 'Ctrl';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        item('New Tab', `${mod}+T`, 'createTab', START_PAGE),
        item('New Window', `${mod}+N`, 'newWindow'),
        item('Reopen Closed Tab', `${mod}+Shift+T`, 'reopenClosedTab'),
        { type: 'separator' },
        item('Close Tab', `${mod}+W`, 'closeActiveTab'),
        item('Print…', `${mod}+P`, 'print'),
        ...(mac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        item('Find…', `${mod}+F`, 'openFind'),
        item('Find Next', `${mod}+G`, 'findNext', true),
        item('Find Previous', `${mod}+Shift+G`, 'findNext', false),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Reload', `${mod}+R`, 'reload'),
        item('Force Reload', `${mod}+Shift+R`, 'forceReload'),
        { type: 'separator' },
        item('Actual Size', `${mod}+0`, 'zoom', 0),
        item('Zoom In', `${mod}+Plus`, 'zoom', 0.5),
        item('Zoom Out', `${mod}+-`, 'zoom', -0.5),
        { type: 'separator' },
        item('Toggle Full Screen', mac ? 'Ctrl+Cmd+F' : 'F11', 'toggleFullScreen'),
        item('View Source', `${mod}+U`, 'viewSource'),
        item('Toggle Developer Tools', mac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', 'toggleDevTools'),
      ],
    },
    {
      label: 'History',
      submenu: [
        item('Back', mac ? 'Cmd+Left' : 'Alt+Left', 'back'),
        item('Forward', mac ? 'Cmd+Right' : 'Alt+Right', 'forward'),
        item('Home', `${mod}+Shift+H`, 'home'),
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        item('Next Tab', 'Ctrl+Tab', 'cycleTab', 1),
        item('Previous Tab', 'Ctrl+Shift+Tab', 'cycleTab', -1),
        { type: 'separator' },
        item('Focus Address Bar', `${mod}+L`, 'focusAddressBar'),
      ],
    },
    {
      label: 'Tools',
      submenu: [
        item('Settings', `${mod}+,`, 'openInternal', 'settings'),
        item('Ad Blocker', `${mod}+Shift+B`, 'openInternal', 'adblock'),
        item('Extensions', `${mod}+Shift+E`, 'openInternal', 'extensions'),
        item('History', `${mod}+Y`, 'openInternal', 'history'),
        { type: 'separator' },
        item('About Nova', null, 'openInternal', 'about'),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  loadSettings();
  await initExtensions();
  buildMenu();
  new BrowserWin();
  // Build the filter engine in the background so it never delays the window.
  initEngine().catch((e) => console.error('[adblock] init failed:', e.message));
  app.on('activate', () => { if (windows.size === 0) new BrowserWin(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
