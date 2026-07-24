// Desarrollado por BlacKraken Solutions (NABA-OL)
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Ruta al binario de FFmpeg. Prioridad:
//  1. FFMPEG_PATH (override explícito).
//  2. macOS: Homebrew (/opt/homebrew o /usr/local) — mejor soporte TLS que ffmpeg-static.
//  3. macOS empaquetado: binario bundleado en Resources/ffmpeg (Fase D).
//  4. ffmpeg-static (Windows y Linux lo usan tal cual — trae binario prebuilt para
//     linux-x64/arm64; en macOS su TLS es limitado, por eso los pasos 2-3 van antes ahí).
//  5. 'ffmpeg' del PATH del sistema — cubre distros donde el usuario ya lo instaló via
//     apt/dnf y prefiere ese en vez del prebuilt de ffmpeg-static.
function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  if (process.platform === 'darwin') {
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (existsSync(p)) return p;
    }
    if (process.resourcesPath) {
      const bundled = path.join(process.resourcesPath, 'ffmpeg');
      if (existsSync(bundled)) return bundled;
    }
  }

  try {
    const require = createRequire(import.meta.url);
    const p = require('ffmpeg-static');
    if (p) return p.replace('app.asar', 'app.asar.unpacked');
  } catch {}

  return 'ffmpeg';
}

export const FFMPEG = resolveFfmpeg();
