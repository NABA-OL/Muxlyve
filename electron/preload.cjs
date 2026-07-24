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
  setTitle:   (title, category) => ipcRenderer.invoke('title:set', title, category),
  // Chequeo previo a salir en vivo — ver checkLiveTokens() en electron/oauth.js.
  checkLiveTokens: () => ipcRenderer.invoke('oauth:check-live-tokens'),
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
  getLanguage: () => ipcRenderer.invoke('app:get-language'),
  setLanguage: (lang) => ipcRenderer.invoke('app:set-language', lang),
  getAllowLanPanel: () => ipcRenderer.invoke('app:get-allow-lan-panel'),
  setAllowLanPanel: (val) => ipcRenderer.invoke('app:set-allow-lan-panel', val),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  // Modal propio de actualización (ver electron/updater.js) — reemplaza los diálogos
  // nativos de dialog.showMessageBox, que Electron no deja personalizar con CSS.
  onUpdaterEvent: (cb) => ipcRenderer.on('updater:event', (_event, payload) => cb(payload)),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  openUpdateWeb: () => ipcRenderer.invoke('updater:open-web'),
  // Notificación nativa del SO — ver app:notify en electron/main.js.
  notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),
  // Controles de ventana propios (Linux, frameless — ver titleBarConfig en main.js).
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winToggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
});
