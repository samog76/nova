'use strict';

// ---------------------------------------------------------------------------
// Preload for tab views. It runs for every page, but only exposes the `nova`
// API on our own internal pages (file:// .../ui/<page>.html). Regular websites
// get nothing, so browsing history and version info stay private to Nova.
// ---------------------------------------------------------------------------
const { contextBridge, ipcRenderer } = require('electron');

const INTERNAL = /\/ui\/(home|settings|adblock|extensions|history|about)\.html$/;

if (location.protocol === 'file:' && INTERNAL.test(location.pathname)) {
  contextBridge.exposeInMainWorld('nova', {
    getHistory: () => ipcRenderer.invoke('nova:get-history'),
    clearHistory: () => ipcRenderer.invoke('nova:clear-history'),
    getVersions: () => ipcRenderer.invoke('nova:get-versions'),
    getSettings: () => ipcRenderer.invoke('nova:get-settings'),
    setSettings: (patch) => ipcRenderer.invoke('nova:set-settings', patch),
    resetSettings: () => ipcRenderer.invoke('nova:reset-settings'),
    getBlockedCount: () => ipcRenderer.invoke('nova:get-blocked-count'),
    adblockState: () => ipcRenderer.invoke('nova:adblock-state'),
    adblockSet: (patch) => ipcRenderer.invoke('nova:adblock-set', patch),
    listExtensions: () => ipcRenderer.invoke('nova:list-extensions'),
    addExtension: () => ipcRenderer.invoke('nova:add-extension'),
    setExtensionEnabled: (path, enabled) => ipcRenderer.invoke('nova:set-extension-enabled', { path, enabled }),
    removeExtension: (path) => ipcRenderer.invoke('nova:remove-extension', { path }),
  });
}
