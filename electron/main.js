// Desarrollado por BlacKraken Solutions (NABA-OL)
import { app, BrowserWindow, shell, ipcMain, dialog, Tray, Menu, nativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  checkLicense,
  activateLicense,
  releaseLicense,
  getLicenseInfo,
  refreshLicenseStatus,
} from './license.js';
import { connect as oauthConnect, disconnect as oauthDisconnect, getStatus as oauthStatus, resumeChatIfConnected } from './oauth.js';
import { initUpdater, checkForUpdatesManually } from './updater.js';
import { initLogBuffer, getRecentLog } from './logbuffer.js';

// Antes que nada — captura logs desde el arranque (la app empaquetada no muestra consola).
initLogBuffer();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_PORT  = Number(process.env.PANEL_PORT || 19080);
const PANEL_URL   = `http://127.0.0.1:${PANEL_PORT}/`;
const ICON_PATH   = path.join(__dirname, '../build/icon-muxlyve.ico');
const TRAY_ICON_PATH = path.join(__dirname, '../build/icon-muxlyve.png');
const PRELOAD       = path.join(__dirname, 'preload.cjs');
const ACTIVATE_HTML = path.join(__dirname, 'activate.html');
const SPLASH_HTML   = path.join(__dirname, 'splash.html');
// Flag propio (no depende del SO) para saber si el login item nos arrancó en modo oculto —
// lo agregamos nosotros mismos a los args del login item, ver app:set-login-item.
const START_HIDDEN = process.argv.includes('--hidden');

// Preferencias simples que persisten entre sesiones, independientes del login item del SO
// (ej. "minimizar a bandeja al cerrar" — a diferencia de "iniciar minimizado", no depende
// de que la app arranque sola con el sistema).
const PREFS_PATH = path.join(app.getPath('userData'), 'prefs.json');
function loadPrefs() {
  try { return JSON.parse(readFileSync(PREFS_PATH, 'utf8')); } catch { return {}; }
}
function savePrefs(prefs) {
  try { writeFileSync(PREFS_PATH, JSON.stringify(prefs)); } catch {}
}
const prefs = loadPrefs();

let win = null;
let splash = null;
let tray = null;

// ── Splash screen ─────────────────────────────────────────────────────────────
function showSplash() {
  splash = new BrowserWindow({
    width: 360, height: 210,
    frame: false,
    resizable: false,
    center: true,
    backgroundColor: '#0d1117',
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    skipTaskbar: true,
    alwaysOnTop: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.loadFile(SPLASH_HTML);
}

function closeSplash() {
  if (!splash) return;
  splash.webContents.executeJavaScript('document.body.style.opacity="0"').catch(() => {});
  setTimeout(() => { if (splash) { splash.close(); splash = null; } }, 300);
}

// ── Panel readiness ────────────────────────────────────────────────────────────
function waitForPanel(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`${PANEL_URL}api/state`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else if (Date.now() > deadline) reject(new Error(`panel respondió ${res.statusCode} — posible conflicto de puerto`));
        else setTimeout(tryOnce, 250);
      });
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
    show: false,
    backgroundColor: '#0d1117',
    title: 'Muxlyve',
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: PRELOAD },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => { if (!START_HIDDEN) win.show(); });
  win.loadURL(PANEL_URL);
  // Ajuste independiente de "iniciar minimizado" — si está activo, cerrar con la X oculta
  // a la bandeja en vez de salir. Solo se sale de verdad desde el menú de la bandeja
  // (Salir usa app.exit(), que no dispara este evento) o desactivando la opción primero.
  win.on('close', (event) => {
    if (prefs.closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

// ── Bandeja del sistema ──────────────────────────────────────────────────────
function createTray() {
  if (tray) return;
  const base = nativeImage.createFromPath(TRAY_ICON_PATH);
  const icon = base.isEmpty() ? base : base.resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip('Muxlyve');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar Muxlyve', click: () => { if (win) { win.show(); win.focus(); } } },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.exit(0); } },
  ]));
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
  });
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
      title: 'Muxlyve — Activar licencia',
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
ipcMain.handle('license:status', () => refreshLicenseStatus());

ipcMain.handle('oauth:connect', (_, platform) => oauthConnect(platform, PANEL_PORT));
ipcMain.handle('oauth:status', () => oauthStatus());
ipcMain.handle('oauth:disconnect', (_, platform) => oauthDisconnect(platform));

function loginItemState() {
  // getLoginItemSettings() sin argumentos compara contra args=[] por defecto — si el
  // login item se registró con args:['--hidden'], esa entrada NO matchea el chequeo por
  // defecto y openAtLogin aparece falso aunque sí esté activo. Hay que consultar ambas
  // variantes explícitamente y ver cuál coincide con lo realmente registrado.
  const hidden = app.getLoginItemSettings({ args: ['--hidden'] });
  if (hidden.openAtLogin) return { openAtLogin: true, startMinimized: true };
  const normal = app.getLoginItemSettings();
  return { openAtLogin: normal.openAtLogin, startMinimized: false };
}
ipcMain.handle('app:get-login-item', () => loginItemState());
ipcMain.handle('app:set-login-item', (_, openAtLogin, startMinimized) => {
  app.setLoginItemSettings({
    openAtLogin: !!openAtLogin,
    args: (openAtLogin && startMinimized) ? ['--hidden'] : [],
  });
  return loginItemState();
});

ipcMain.handle('updater:check', () => {
  if (!app.isPackaged) return { ok: false, error: 'Solo disponible en la app empaquetada.' };
  checkForUpdatesManually();
  return { ok: true };
});

ipcMain.handle('app:get-close-to-tray', () => !!prefs.closeToTray);
ipcMain.handle('app:set-close-to-tray', (_, val) => {
  prefs.closeToTray = !!val;
  savePrefs(prefs);
  return prefs.closeToTray;
});

ipcMain.handle('report:send', async (_, description) => {
  try {
    const license = getLicenseInfo();
    const body = JSON.stringify({
      email: license?.email || '',
      appVersion: app.getVersion(),
      platform: process.platform,
      // process.getSystemVersion() da la versión real del SO (ej. macOS 15.1) — os.release()
      // solo da la versión del kernel Darwin, que no es lo que un humano reconoce.
      osVersion: `${process.platform === 'darwin' ? 'macOS' : 'Windows'} ${process.getSystemVersion()}`,
      description: description || '',
      log: getRecentLog(),
    });
    const res = await fetch('https://muxlyve.com/api/support/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
// Registra muxlyve:// como protocolo de la app (necesario para OAuth redirect en producción).
app.setAsDefaultProtocolClient('muxlyve');

app.whenReady().then(async () => {
  // Carga .env desde userData sin dependencias externas.
  const userEnv = path.join(app.getPath('userData'), '.env');
  if (existsSync(userEnv)) {
    const { readFileSync } = await import('node:fs');
    for (const line of readFileSync(userEnv, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }

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

  // Migración única: recupera destinations.json de ubicaciones legacy si no está en userData.
  if (app.isPackaged) {
    const userDest = path.join(app.getPath('userData'), 'destinations.json');
    if (!existsSync(userDest)) {
      const legacyPaths = [
        // junto al ejecutable / recursos (versiones muy antiguas)
        path.join(process.resourcesPath, '..', 'config', 'destinations.json'),
        // directorio de trabajo
        path.join(process.cwd(), 'config', 'destinations.json'),
      ];
      for (const legacy of legacyPaths) {
        if (existsSync(legacy)) {
          try {
            mkdirSync(app.getPath('userData'), { recursive: true });
            copyFileSync(legacy, userDest);
            console.log(`[config] Migrado destinations.json desde ${legacy}`);
          } catch (e) {
            console.warn('[config] No se pudo migrar:', e.message);
          }
          break;
        }
      }
    }
  }

  // Si arrancó oculto (login item con --hidden), sáltate el splash — no debe verse nada.
  if (!START_HIDDEN) showSplash();

  // Arranca el motor (NMS + relays + panel) por efecto de import.
  try {
    await import('../src/index.js');
  } catch (err) {
    console.error('[electron] ERROR al arrancar el motor:', err.message, err.stack);
    dialog.showErrorBox('Error al iniciar Muxlyve', `No se pudo arrancar el motor:\n${err.message}`);
    app.quit();
    return;
  }
  try {
    await waitForPanel();
  } catch (err) {
    console.error('[electron] panel no respondió:', err.message);
  }
  // Señal al splash: completa animación a 100%, luego fade.
  if (splash) {
    splash.webContents.executeJavaScript('window.finishLoad && window.finishLoad()').catch(() => {});
    await new Promise(r => setTimeout(r, 1050)); // 500ms barra + 300ms hold + margen
  }
  closeSplash();
  createWindow();
  createTray();
  resumeChatIfConnected();
  win.webContents.on('did-fail-load', (_, code, desc, url) => {
    console.error('[electron] did-fail-load:', code, desc, url);
  });
  if (app.isPackaged) initUpdater(win);

  // Revalidar licencia cada 6 h en segundo plano.
  if (app.isPackaged || process.env.MS_FORCE_LICENSE === '1') {
    setInterval(async () => {
      const r = await checkLicense({ isPackaged: true });
      if (!r.unlocked) {
        console.log('[license] revalidación: BLOQUEADA —', r.reason);
        await dialog.showMessageBox({
          type: 'warning',
          title: 'Suscripción inactiva',
          message: r.reason === 'subscription-cancelled'
            ? 'Tu suscripción fue cancelada. La app se cerrará.'
            : 'Tu licencia ya no es válida. La app se cerrará.',
          buttons: ['Cerrar'],
        });
        app.relaunch();
        app.quit();
      }
    }, 6 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (win) { win.show(); win.focus(); }
  });
});

// Con "iniciar minimizado" activo, close() se intercepta arriba (hide en vez de destruir),
// así que la ventana nunca llega a "closed" mientras ese modo esté activo — este evento
// solo dispara en el flujo normal (X cierra de verdad) o tras "Salir" desde la bandeja.
app.on('window-all-closed', () => app.quit());

app.on('before-quit', async () => {
  try {
    const { onUnpublish } = await import('../src/relays.js');
    onUnpublish();
  } catch { /* motor pudo no haber arrancado */ }
});
