// Desarrollado por BlacKraken Solutions (NABA-OL)
// Ajustes editables desde el panel que no son "destinos" (config/destinations.json) —
// hoy solo la clave de retransmisión. Mismo criterio que destinations.js: JSON en
// MS_CONFIG_DIR (o config/ del paquete), funciona igual en Electron y headless/Docker.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.MS_CONFIG_DIR || path.join(__dirname, '..', 'config');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');

const DEFAULT_STREAM_KEY = process.env.STREAM_KEY || 'mistream';
// Segmento de URL RTMP y del path del flv — mismo criterio que las claves de destino,
// sin espacios ni caracteres que puedan romper la ruta.
const STREAM_KEY_RE = /^[A-Za-z0-9_-]{3,64}$/;

export function isValidStreamKey(key) {
  return typeof key === 'string' && STREAM_KEY_RE.test(key);
}

// Duraciones válidas del buffer rodante (segundos) — mismo set que REC_DURATIONS en
// panel.js. Se persiste acá (no solo en localStorage del panel) porque antes de este
// fix, armar el buffer SIN señal activa (armRecording) nunca guardaba la duración
// elegida — onPublish() arrancaba con el default viejo en memoria (60s = 1 min) en vez
// de la que el usuario había elegido, hasta que tocaba des/activar de nuevo YA en vivo.
const REC_DURATIONS = [60, 300, 600, 900];
export function isValidRecDuration(d) {
  return REC_DURATIONS.includes(Number(d));
}

const DEFAULT_SETTINGS = {
  streamKey: DEFAULT_STREAM_KEY, recArmed: false, fullRecArmed: false, recDuration: 60,
  clipsDir: null, recordingsDir: null,
};

function validDir(d) {
  return typeof d === 'string' && d.trim() ? d.trim() : null;
}

// Si el usuario nunca la cambió, sigue siendo la de siempre (env var o "mistream") —
// no hace falta escribir el archivo hasta que de verdad la edite. recArmed/fullRecArmed:
// "quiero que el buffer/la grabación arranque solo apenas llegue señal" — server-side
// (no localStorage) a propósito, para que el plugin de Stream Deck y el panel vean
// exactamente el mismo estado sin importar quién lo prendió. clipsDir/recordingsDir:
// mismo criterio — antes solo vivían en localStorage del panel, así que el plugin de
// Stream Deck (sin acceso a ese localStorage) siempre guardaba en la carpeta default,
// nunca en la que el usuario configuró.
export function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    return {
      streamKey: isValidStreamKey(data.streamKey) ? data.streamKey : DEFAULT_STREAM_KEY,
      recArmed: !!data.recArmed,
      fullRecArmed: !!data.fullRecArmed,
      recDuration: isValidRecDuration(data.recDuration) ? Number(data.recDuration) : 60,
      clipsDir: validDir(data.clipsDir),
      recordingsDir: validDir(data.recordingsDir),
    };
  } catch (err) {
    console.error('[config] No se pudo leer settings.json:', err.message);
    return { ...DEFAULT_SETTINGS };
  }
}

// Merge parcial — cada llamador solo manda el campo que le importa (ej. { recArmed: true }),
// sin esto pisaría el resto del archivo (streamKey, el otro armed) con undefined.
export function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}
