import { autoUpdater } from 'electron-updater';
import { dialog } from 'electron';

export function initUpdater(win) {
  // Solo correr en builds empaquetados; en dev no hay releases que buscar.
  if (!win) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Actualización disponible',
      message: `Multi_Stream ${info.version} está disponible.`,
      detail: 'Se descargará en segundo plano mientras transmites.',
      buttons: ['Descargar', 'Ahora no'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.downloadUpdate();
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Actualización lista',
      message: `Multi_Stream ${info.version} descargada.`,
      detail: 'Reinicia la app para aplicar la actualización. Puedes hacerlo ahora o después.',
      buttons: ['Reiniciar ahora', 'Después'],
      defaultId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err.message);
  });

  // Busca actualizaciones 5s después del arranque para no bloquear el inicio.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] checkForUpdates:', err.message);
    });
  }, 5000);
}
