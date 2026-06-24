import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'destinations.json');
const EXAMPLE_PATH = path.join(__dirname, '..', 'config', 'destinations.example.json');

const PLACEHOLDERS = ['TU_CLAVE', 'CLAVE_TEMPORAL', 'SERVIDOR_TIKTOK'];

// Valida que la URL sea un destino RTMP real y no un placeholder de la plantilla.
export function isValidUrl(url) {
  if (typeof url !== 'string') return false;
  if (!/^rtmps?:\/\//i.test(url)) return false;
  return !PLACEHOLDERS.some((p) => url.includes(p));
}

// Un destino se reenvía si está habilitado y su URL es válida.
export function isPlayable(dest) {
  return Boolean(dest && dest.enabled && isValidUrl(dest.url));
}

// Lee la lista completa (incluye deshabilitados/incompletos) para el panel.
export function loadAll() {
  const file = existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_PATH;
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    return Array.isArray(data.destinations) ? data.destinations : [];
  } catch (err) {
    console.error('[config] No se pudo leer destinations.json:', err.message);
    return [];
  }
}

// Escribe la lista completa en config/destinations.json (siempre el archivo real, no el ejemplo).
export function saveAll(destinations) {
  writeFileSync(CONFIG_PATH, JSON.stringify({ destinations }, null, 2) + '\n', 'utf-8');
}
