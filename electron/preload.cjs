// Preload CJS: puente seguro entre el renderer (activate.html) y el main process.
// contextIsolation=true + nodeIntegration=false → solo lo expuesto aquí llega al renderer.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('msLicense', {
  activate: (key) => ipcRenderer.invoke('license:activate', key),
  release:  ()    => ipcRenderer.invoke('license:release'),
  getInfo:  ()    => ipcRenderer.invoke('license:info'),
});
