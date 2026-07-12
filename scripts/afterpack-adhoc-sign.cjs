// Desarrollado por BlacKraken Solutions (NABA-OL)
// Re-firma ad-hoc el .app COMPLETO tras el empaquetado. En Apple Silicon, el binario de
// Electron ya trae una firma ad-hoc interna (del compilador), pero cuando electron-builder
// arma el bundle final (agrega app.asar, FFmpeg, ícono, etc.) esa firma queda incompleta —
// sella el ejecutable pero no los recursos que se agregaron después. macOS lo rechaza como
// "dañado, mover al basurero" en vez del aviso normal y manejable de "desarrollador no
// identificado, abrir de todas formas". No sustituye la firma real de Apple Developer ID
// (sigue sin pasar notarización), solo evita el mensaje de error más agresivo.
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log(`[afterPack] Re-firmando ad-hoc: ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
