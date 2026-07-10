// Desarrollado por BlacKraken Solutions (NABA-OL)
import { createRequire } from 'node:module';
import { dialog, shell } from 'electron';
const { autoUpdater } = createRequire(import.meta.url)('electron-updater');

const DOWNLOAD_URLS = {
  darwin: 'https://muxlyve.com/api/download/mac',
  win32: 'https://muxlyve.com/api/download/win',
};

function webDownloadUrl() {
  return DOWNLOAD_URLS[process.platform] || 'https://muxlyve.com';
}

// El chequeo automático al arranque es silencioso si no hay nada nuevo — pero un click
// manual del usuario en "Buscar actualizaciones" sí necesita confirmar "ya tienes la
// última versión", si no, un botón que aparentemente no hace nada es mala UX.
let manualCheck = false;
let updaterWin = null;

export function checkForUpdatesManually() {
  manualCheck = true;
  return autoUpdater.checkForUpdates().catch((err) => {
    manualCheck = false;
    console.error('[updater] checkForUpdatesManually:', err.message);
    if (updaterWin && !updaterWin.isDestroyed()) {
      dialog.showMessageBox(updaterWin, {
        type: 'error',
        title: 'No se pudo buscar actualizaciones',
        message: err.message,
        buttons: ['Cerrar'],
      });
    }
  });
}

export function initUpdater(win) {
  // Solo correr en builds empaquetados; en dev no hay releases que buscar.
  if (!win) return;
  updaterWin = win;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    manualCheck = false;
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Actualización disponible',
      message: `Muxlyve ${info.version} está disponible.`,
      detail: 'Se descargará en segundo plano mientras transmites.',
      buttons: ['Descargar', 'Descargar desde la web', 'Ahora no'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.downloadUpdate().catch((err) => {
          console.error('[updater] downloadUpdate:', err.message);
        });
      } else if (response === 1) {
        shell.openExternal(webDownloadUrl());
      }
    });
  });

  autoUpdater.on('update-not-available', () => {
    if (!manualCheck) return; // el chequeo automático no molesta al usuario si no hay nada nuevo
    manualCheck = false;
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Sin actualizaciones',
      message: 'Ya tienes la última versión de Muxlyve.',
      buttons: ['OK'],
    });
  });

  // Barra de progreso nativa en el ícono del dock (macOS) / la barra de tareas (Windows) —
  // sin necesitar UI propia. setProgressBar(-1) la quita.
  autoUpdater.on('download-progress', (progress) => {
    if (!win.isDestroyed()) win.setProgressBar(progress.percent / 100);
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (!win.isDestroyed()) win.setProgressBar(-1);
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Actualización lista',
      message: `Muxlyve ${info.version} descargada.`,
      detail: 'Reinicia la app para aplicar la actualización. Puedes hacerlo ahora o después.',
      buttons: ['Reiniciar ahora', 'Después'],
      defaultId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  // Falla típica en Mac sin firma de Apple Developer ID: Squirrel.Mac rechaza aplicar
  // la actualización sin firma válida. Mientras no haya certificado, ofrece el link web.
  autoUpdater.on('error', (err) => {
    manualCheck = false;
    console.error('[updater]', err.message);
    if (!win.isDestroyed()) win.setProgressBar(-1);
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'Error al actualizar',
      message: 'No se pudo descargar la actualización automáticamente.',
      detail: `${err.message}\n\nPuedes descargarla manualmente desde la página web.`,
      buttons: ['Descargar desde la web', 'Cerrar'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) shell.openExternal(webDownloadUrl());
    });
  });

  // Busca actualizaciones 5s después del arranque para no bloquear el inicio.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] checkForUpdates:', err.message);
    });
  }, 5000);
}
