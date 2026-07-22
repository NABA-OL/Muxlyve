// Desarrollado por BlacKraken Solutions (NABA-OL)
import { createRequire } from 'node:module';
import { shell, ipcMain } from 'electron';
const { autoUpdater } = createRequire(import.meta.url)('electron-updater');

const DOWNLOAD_URLS = {
  darwin: 'https://muxlyve.com/api/download/mac',
  win32: 'https://muxlyve.com/api/download/win',
};

function webDownloadUrl() {
  return DOWNLOAD_URLS[process.platform] || 'https://muxlyve.com';
}

// Mismo criterio que el resto de la app (electron/main.js, oauth.js): se lee al momento
// de la llamada, no al importar.
function es() {
  return process.env.APP_LANG === 'es';
}

// dialog.showMessageBox es un diálogo NATIVO del SO (NSAlert en Mac, el genérico de
// Windows) — Electron no permite darle estilo propio. En vez de eso, este módulo manda
// un evento por IPC y panel.js dibuja un modal propio (mismo .prefs-modal que el resto
// de la app) — ver handleUpdaterEvent() en el <script> de PANEL_HTML.
let updaterWin = null;
function sendUpdaterEvent(payload) {
  if (updaterWin && !updaterWin.isDestroyed()) {
    updaterWin.webContents.send('updater:event', payload);
  }
}

// El chequeo automático al arranque es silencioso si no hay nada nuevo — pero un click
// manual del usuario en "Buscar actualizaciones" sí necesita confirmar "ya tienes la
// última versión", si no, un botón que aparentemente no hace nada es mala UX.
let manualCheck = false;
let downloading = false; // true entre click en "Descargar" y el evento downloaded/error

export function checkForUpdatesManually() {
  manualCheck = true;
  return autoUpdater.checkForUpdates().catch((err) => {
    manualCheck = false;
    console.error('[updater] checkForUpdatesManually:', err.message);
    sendUpdaterEvent({
      type: 'error',
      title: es() ? 'No se pudo buscar actualizaciones' : 'Could not check for updates',
      message: err.message,
    });
  });
}

export function initUpdater(win) {
  // Solo correr en builds empaquetados; en dev no hay releases que buscar.
  if (!win) return;
  updaterWin = win;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  ipcMain.handle('updater:download', () => {
    downloading = true;
    return autoUpdater.downloadUpdate().catch((err) => {
      console.error('[updater] downloadUpdate:', err.message);
    });
  });
  ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall());
  ipcMain.handle('updater:open-web', () => shell.openExternal(webDownloadUrl()));

  autoUpdater.on('update-available', (info) => {
    manualCheck = false;
    sendUpdaterEvent({
      type: 'available',
      title: es() ? 'Actualización disponible' : 'Update available',
      message: es() ? `Muxlyve ${info.version} está disponible.` : `Muxlyve ${info.version} is available.`,
      detail: es() ? 'Se descargará en segundo plano mientras transmites.' : 'It will download in the background while you stream.',
    });
  });

  autoUpdater.on('update-not-available', () => {
    if (!manualCheck) return; // el chequeo automático no molesta al usuario si no hay nada nuevo
    manualCheck = false;
    sendUpdaterEvent({
      type: 'not-available',
      title: es() ? 'Sin actualizaciones' : 'No updates',
      message: es() ? 'Ya tienes la última versión de Muxlyve.' : 'You already have the latest version of Muxlyve.',
    });
  });

  // Barra de progreso nativa en el ícono del dock (macOS) / la barra de tareas (Windows) —
  // se mantiene (se ve bien nativo en ambas plataformas) además de la barra propia del
  // modal, para que quede claro que la descarga avanza incluso con internet lento.
  autoUpdater.on('download-progress', (progress) => {
    if (!win.isDestroyed()) win.setProgressBar(progress.percent / 100);
    sendUpdaterEvent({
      type: 'progress',
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloading = false;
    if (!win.isDestroyed()) win.setProgressBar(-1);
    sendUpdaterEvent({
      type: 'downloaded',
      title: es() ? 'Actualización lista' : 'Update ready',
      message: es() ? `Muxlyve ${info.version} descargada.` : `Muxlyve ${info.version} downloaded.`,
      detail: es()
        ? 'Reinicia la app para aplicar la actualización. Puedes hacerlo ahora o después.'
        : 'Restart the app to apply the update. You can do it now or later.',
    });
  });

  // Falla típica en Mac sin firma de Apple Developer ID: Squirrel.Mac rechaza aplicar
  // la actualización sin firma válida. Mientras no haya certificado, ofrece el link web.
  autoUpdater.on('error', (err) => {
    const wasUserInitiated = manualCheck || downloading;
    manualCheck = false;
    downloading = false;
    console.error('[updater]', err.message);
    if (!win.isDestroyed()) win.setProgressBar(-1);
    // El chequeo silencioso de fondo no debe interrumpir al usuario con un error (p.ej.
    // sin internet al abrir la app) — solo se avisa si pidió el chequeo o ya estaba
    // descargando (ahí sí lo está esperando).
    if (!wasUserInitiated) return;
    sendUpdaterEvent({
      type: 'error',
      title: es() ? 'Error al actualizar' : 'Update error',
      message: es() ? 'No se pudo descargar la actualización automáticamente.' : 'Could not download the update automatically.',
      detail: err.message,
    });
  });

  // Busca actualizaciones 5s después del arranque para no bloquear el inicio.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] checkForUpdates:', err.message);
    });
  }, 5000);
}
