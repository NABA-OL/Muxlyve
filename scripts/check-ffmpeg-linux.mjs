#!/usr/bin/env node
// Desarrollado por BlacKraken Solutions (NABA-OL)
// ffmpeg-static descarga el binario que corresponde a la plataforma donde corrió
// `npm install` (postinstall), NO a la plataforma target de electron-builder — si
// dist:linux corre en una Mac (o Windows), este binario sigue siendo el de esa
// plataforma y electron-builder lo empaqueta igual, sin avisar. El resultado: un
// AppImage con un ffmpeg que no ejecuta en Linux (visto en pruebas: seguía siendo
// Mach-O de macOS). Este chequeo corta el build ANTES de empaquetar en vez de dejar
// que el usuario final se encuentre con un ffmpeg roto.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (err) {
  console.error('✗ No se pudo resolver ffmpeg-static:', err.message);
  process.exit(1);
}

if (!existsSync(ffmpegPath)) {
  console.error(`✗ ffmpeg-static no tiene binario en ${ffmpegPath}`);
  process.exit(1);
}

// Magic bytes: ELF = 0x7f 'E' 'L' 'F'. Mach-O = 0xcf/0xce 0xfa 0xed 0xfe (o variante fat).
const header = Buffer.alloc(4);
const fd = require('node:fs').openSync(ffmpegPath, 'r');
require('node:fs').readSync(fd, header, 0, 4, 0);
require('node:fs').closeSync(fd);

const isElf = header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
if (!isElf) {
  console.error(
    `✗ ${ffmpegPath} no es un binario ELF de Linux (probablemente quedó el de la plataforma\n` +
    '  donde corrió "npm install"). dist:linux debe correr en una máquina Linux real (o un\n' +
    '  contenedor Docker linux/amd64 o linux/arm64) para que el postinstall de ffmpeg-static\n' +
    '  baje el binario correcto — no funciona cross-build desde macOS/Windows.',
  );
  process.exit(1);
}

console.log('✓ ffmpeg-static trae un binario ELF de Linux válido.');
