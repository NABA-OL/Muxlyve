import { app, BrowserWindow, shell, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  checkLicense,
  activateLicense,
  releaseLicense,
  getLicenseInfo,
} from './license.js';
import { initUpdater } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_PORT  = Number(process.env.PANEL_PORT || 8080);
const PANEL_URL   = `http://127.0.0.1:${PANEL_PORT}/`;
const ICON_PATH   = path.join(__dirname, '../build/icon.ico');
const PRELOAD     = path.join(__dirname, 'preload.cjs');
const ACTIVATE_HTML = path.join(__dirname, 'activate.html');

let win = null;

// ── Panel readiness ────────────────────────────────────────────────────────────
function waitForPanel(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`${PANEL_URL}api/state`, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('el panel no arrancó a tiempo'));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

// ── Main window ───────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'Multi_Stream',
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(PANEL_URL);
  win.on('closed', () => { win = null; });
}

// ── Activation window ─────────────────────────────────────────────────────────
let activationWin = null;
let activationResolve = null;

function showActivationWindow() {
  return new Promise((resolve) => {
    activationResolve = resolve;
    activationWin = new BrowserWindow({
      width: 520, height: 500,
      resizable: false,
      center: true,
      backgroundColor: '#0d1117',
      title: 'Multi_Stream — Activar licencia',
      icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: PRELOAD,
      },
    });
    activationWin.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    activationWin.loadFile(ACTIVATE_HTML);
    activationWin.on('closed', () => {
      activationWin = null;
      // Cerrado sin activar → salir de la app.
      if (activationResolve) { activationResolve = null; app.quit(); }
    });
  });
}

function resolveActivation() {
  const resolve = activationResolve;
  activationResolve = null;
  // Cierra la ventana de activación tras un breve delay (el renderer muestra "Activado…").
  setTimeout(() => {
    if (activationWin) { activationWin.close(); activationWin = null; }
    if (resolve) resolve();
  }, 900);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('license:activate', async (_, key) => {
  const result = await activateLicense(key);
  if (result.ok) resolveActivation();
  return result;
});

ipcMain.handle('license:release', async () => {
  const result = await releaseLicense();
  // Reiniciar la app para volver a mostrar la pantalla de activación.
  if (result.ok) { app.relaunch(); app.quit(); }
  return result;
});

ipcMain.handle('license:info', () => getLicenseInfo());

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const license = await checkLicense({ isPackaged: app.isPackaged });
  console.log(`[electron] licencia: ${license.unlocked ? 'OK' : 'BLOQUEADA'} (${license.reason})`);

  if (!license.unlocked) {
    console.log('[electron] Mostrando pantalla de activación.');
    await showActivationWindow(); // espera hasta que el usuario active o cierre
  }

  // Config dir fuera de app.asar cuando está empaquetado.
  if (app.isPackaged && !process.env.MS_CONFIG_DIR) {
    process.env.MS_CONFIG_DIR = app.getPath('userData');
  }

  // Arranca el motor (NMS + relays + panel) por efecto de import.
  await import('../src/index.js');
  try {
    await waitForPanel();
  } catch (err) {
    console.error('[electron]', err.message);
  }
  createWindow();
  if (app.isPackaged) initUpdater(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', async () => {
  try {
    const { onUnpublish } = await import('../src/relays.js');
    onUnpublish();
  } catch { /* motor pudo no haber arrancado */ }
});
