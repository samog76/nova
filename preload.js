'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browser', {
  platform: process.platform,

  // Commands -> main process
  newTab: (url) => ipcRenderer.send('action:new-tab', url),
  closeTab: (id) => ipcRenderer.send('action:close-tab', id),
  activateTab: (id) => ipcRenderer.send('action:activate-tab', id),
  navigate: (id, input) => ipcRenderer.send('action:navigate', { id, input }),
  back: () => ipcRenderer.send('action:back'),
  forward: () => ipcRenderer.send('action:forward'),
  reload: () => ipcRenderer.send('action:reload'),
  stop: () => ipcRenderer.send('action:stop'),
  home: () => ipcRenderer.send('action:home'),
  appMenu: (pos) => ipcRenderer.send('action:app-menu', pos),

  // Find in page
  findQuery: (text, forward, findNext) => ipcRenderer.send('find:query', { text, forward, findNext }),
  findClose: () => ipcRenderer.send('find:close'),

  // Events <- main process
  onTabCreated: (cb) => ipcRenderer.on('tab:created', (_e, d) => cb(d)),
  onTabActivated: (cb) => ipcRenderer.on('tab:activated', (_e, d) => cb(d)),
  onTabClosed: (cb) => ipcRenderer.on('tab:closed', (_e, d) => cb(d)),
  onTabState: (cb) => ipcRenderer.on('tab:state', (_e, d) => cb(d)),
  onTabFavicon: (cb) => ipcRenderer.on('tab:favicon', (_e, d) => cb(d)),
  onFocusOmnibox: (cb) => ipcRenderer.on('focus-omnibox', () => cb()),
  onFindOpen: (cb) => ipcRenderer.on('find:open', () => cb()),
  onFindClose: (cb) => ipcRenderer.on('find:close', () => cb()),
  onFindResult: (cb) => ipcRenderer.on('find:result', (_e, d) => cb(d)),
  onFindRepeat: (cb) => ipcRenderer.on('find:repeat', (_e, d) => cb(d)),
});
