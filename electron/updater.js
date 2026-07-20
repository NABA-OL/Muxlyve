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

// Mismo criterio que el resto de la app (electron/main.js, oauth.js): se lee al momento
// de la llamada, no al importar — el usuario puede cambiar el idioma en caliente desde
// Preferencias sin reiniciar este módulo.
function es() {
  return process.env.APP_LANG === 'es';
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
        title: es() ? 'No se pudo buscar actualizaciones' : 'Could not check for updates',
        message: err.message,
        buttons: [es() ? 'Cerrar' : 'Close'],
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
      title: es() ? 'Actualización disponible' : 'Update available',
      message: es() ? `Muxlyve ${info.version} está disponible.` : `Muxlyve ${info.version} is available.`,
      detail: es() ? 'Se descargará en segundo plano mientras transmites.' : 'It will download in the background while you stream.',
      buttons: es() ? ['Descargar', 'Descargar desde la web', 'Ahora no'] : ['Download', 'Download from the web', 'Not now'],
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
      title: es() ? 'Sin actualizaciones' : 'No updates',
      message: es() ? 'Ya tienes la última versión de Muxlyve.' : 'You already have the latest version of Muxlyve.',
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
      title: es() ? 'Actualización lista' : 'Update ready',
      message: es() ? `Muxlyve ${info.version} descargada.` : `Muxlyve ${info.version} downloaded.`,
      detail: es()
        ? 'Reinicia la app para aplicar la actualización. Puedes hacerlo ahora o después.'
        : 'Restart the app to apply the update. You can do it now or later.',
      buttons: es() ? ['Reiniciar ahora', 'Después'] : ['Restart now', 'Later'],
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
      title: es() ? 'Error al actualizar' : 'Update error',
      message: es() ? 'No se pudo descargar la actualización automáticamente.' : 'Could not download the update automatically.',
      detail: es()
        ? `${err.message}\n\nPuedes descargarla manualmente desde la página web.`
        : `${err.message}\n\nYou can download it manually from the website.`,
      buttons: es() ? ['Descargar desde la web', 'Cerrar'] : ['Download from the web', 'Close'],
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
