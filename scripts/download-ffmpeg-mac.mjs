#!/usr/bin/env node
// Desarrollado por NABA-OL
// Copia ffmpeg de Homebrew (TLS completo) y bundlea sus dylibs no-sistema
// para que el .app funcione en Macs sin Homebrew instalado.
import { execSync } from 'node:child_process';
import { existsSync, chmodSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR  = 'build/mac';
const OUT_FILE = path.join(OUT_DIR, 'ffmpeg');
const LIB_DIR  = path.join(OUT_DIR, 'libs');

mkdirSync(OUT_DIR, { recursive: true });

if (existsSync(OUT_FILE)) {
  console.log('✓ build/mac/ffmpeg existe — saltando.');
  process.exit(0);
}

// 1. Localizar ffmpeg de Homebrew (tiene TLS/OpenSSL → Kick funciona)
const brewPaths = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
const src = brewPaths.find(p => existsSync(p));
if (!src) {
  console.error('✗ ffmpeg no encontrado en Homebrew. Instala con: brew install ffmpeg');
  process.exit(1);
}

console.log(`⚙ Copiando ${src} → ${OUT_FILE} ...`);
execSync(`cp "${src}" "${OUT_FILE}"`);
chmodSync(OUT_FILE, 0o755);

// 2. dylibbundler: copia las dylibs de Homebrew y reescribe los paths
//    para que el binario las encuentre en @executable_path/libs/
try {
  execSync('which dylibbundler', { stdio: 'pipe' });
} catch {
  console.log('📦 Instalando dylibbundler (brew)...');
  execSync('brew install dylibbundler', { stdio: 'inherit' });
}

mkdirSync(LIB_DIR, { recursive: true });
console.log('🔗 Bundleando dylibs de Homebrew (puede tardar ~30s)...');
execSync(
  `dylibbundler -b -x "${OUT_FILE}" -d "${LIB_DIR}" -p @executable_path/libs/ -od`,
  { stdio: 'inherit' }
);

const ffmpegMB = (statSync(OUT_FILE).size / 1024 / 1024).toFixed(1);
const libCount = readdirSync(LIB_DIR).length;
console.log(`✓ build/mac/ffmpeg listo (${ffmpegMB} MB) + ${libCount} dylibs en build/mac/libs/`);
