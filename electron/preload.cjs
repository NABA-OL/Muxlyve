// Desarrollado por BlacKraken Solutions (NABA-OL)
// Preload CJS: puente seguro entre el renderer (activate.html) y el main process.
// contextIsolation=true + nodeIntegration=false → solo lo expuesto aquí llega al renderer.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('msLicense', {
  activate:  (key) => ipcRenderer.invoke('license:activate', key),
  release:   ()    => ipcRenderer.invoke('license:release'),
  getInfo:   ()    => ipcRenderer.invoke('license:info'),
  getStatus: ()    => ipcRenderer.invoke('license:status'),
});
contextBridge.exposeInMainWorld('msOAuth', {
  connect:    (platform) => ipcRenderer.invoke('oauth:connect', platform),
  status:     ()         => ipcRenderer.invoke('oauth:status'),
  disconnect: (platform) => ipcRenderer.invoke('oauth:disconnect', platform),
  setTitle:   (title)    => ipcRenderer.invoke('title:set', title),
});
contextBridge.exposeInMainWorld('msApp', {
  getLoginItem: () => ipcRenderer.invoke('app:get-login-item'),
  setLoginItem: (openAtLogin, startMinimized) => ipcRenderer.invoke('app:set-login-item', openAtLogin, startMinimized),
  sendReport: (description) => ipcRenderer.invoke('report:send', description),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  isPackaged: () => ipcRenderer.invoke('app:is-packaged'),
  setTitleBarTheme: (isDark) => ipcRenderer.invoke('app:set-titlebar-theme', isDark),
  openChatWindow: (theme) => ipcRenderer.invoke('chat:open-window', theme),
  getCloseToTray: () => ipcRenderer.invoke('app:get-close-to-tray'),
  setCloseToTray: (val) => ipcRenderer.invoke('app:set-close-to-tray', val),
});
