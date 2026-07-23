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

// Si el usuario nunca la cambió, sigue siendo la de siempre (env var o "mistream") —
// no hace falta escribir el archivo hasta que de verdad la edite. recArmed/fullRecArmed:
// "quiero que el buffer/la grabación arranque solo apenas llegue señal" — server-side
// (no localStorage) a propósito, para que el plugin de Stream Deck y el panel vean
// exactamente el mismo estado sin importar quién lo prendió.
export function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) return { streamKey: DEFAULT_STREAM_KEY, recArmed: false, fullRecArmed: false };
  try {
    const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    return {
      streamKey: isValidStreamKey(data.streamKey) ? data.streamKey : DEFAULT_STREAM_KEY,
      recArmed: !!data.recArmed,
      fullRecArmed: !!data.fullRecArmed,
    };
  } catch (err) {
    console.error('[config] No se pudo leer settings.json:', err.message);
    return { streamKey: DEFAULT_STREAM_KEY, recArmed: false, fullRecArmed: false };
  }
}

// Merge parcial — cada llamador solo manda el campo que le importa (ej. { recArmed: true }),
// sin esto pisaría el resto del archivo (streamKey, el otro armed) con undefined.
export function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}
