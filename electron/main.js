import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { checkLicense } from './license.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_PORT = Number(process.env.PANEL_PORT || 8080);
const ICON_PATH = path.join(__dirname, '../build/icon.ico');
const PANEL_URL = `http://127.0.0.1:${PANEL_PORT}/`;

let win = null;

// Espera a que el panel HTTP del motor esté escuchando antes de cargar la ventana.
function waitForPanel(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`${PANEL_URL}api/state`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('el panel no arrancó a tiempo'));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'Multi_Stream',
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Los enlaces externos abren en el navegador del sistema, no dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(PANEL_URL);
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  const license = checkLicense({ isPackaged: app.isPackaged });
  console.log(`[electron] licencia: ${license.unlocked ? 'desbloqueada' : 'bloqueada'} (${license.reason})`);
  // En Fase A la puerta está desactivada: license.unlocked siempre true.

  // Empaquetado: el config va a userData (escribible); src/ está en app.asar de solo lectura.
  // En dev usa el config/ del repo (mismo comportamiento que `npm start`).
  if (app.isPackaged && !process.env.MS_CONFIG_DIR) {
    process.env.MS_CONFIG_DIR = app.getPath('userData');
  }

  // Arranca el motor actual (NMS + relays + panel) por efecto de import.
  await import('../src/index.js');
  try {
    await waitForPanel();
  } catch (err) {
    console.error('[electron]', err.message);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit(); // también en macOS: la app es un único panel, no un documento.
});

// Al cerrar, detén los relays FFmpeg para no dejar procesos huérfanos.
app.on('before-quit', async () => {
  try {
    const { onUnpublish } = await import('../src/relays.js');
    onUnpublish();
  } catch { /* el motor pudo no haber arrancado */ }
});
