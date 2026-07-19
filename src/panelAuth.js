// Desarrollado por BlacKraken Solutions (NABA-OL)
// Token compartido para autenticar la API del panel cuando queda expuesta a la LAN
// (ALLOW_LAN_PANEL=true) — ver nota de seguridad en src/panel.js. Se genera una sola vez
// y se persiste en disco: el plugin de Stream Deck (u otro cliente remoto) lo configura
// una vez y no cambia en cada reinicio de la app.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Mismo patrón que src/destinations.js: MS_CONFIG_DIR permite escribir fuera del
// paquete (la app Electron lo apunta a userData, src/ va dentro de app.asar de solo lectura).
const CONFIG_DIR = process.env.MS_CONFIG_DIR || path.join(__dirname, '..', 'config');
const TOKEN_PATH = path.join(CONFIG_DIR, 'panel-token.json');

let cached = null;

export function getOrCreatePanelToken() {
  if (process.env.PANEL_TOKEN) return process.env.PANEL_TOKEN;
  if (cached) return cached;
  try {
    if (existsSync(TOKEN_PATH)) {
      const { token } = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
      if (token) { cached = token; return token; }
    }
  } catch {}
  const token = randomBytes(24).toString('base64url');
  try {
    writeFileSync(TOKEN_PATH, JSON.stringify({ token }, null, 2));
  } catch (err) {
    console.error('[panel-auth] No se pudo guardar el token en disco:', err.message);
  }
  cached = token;
  return token;
}

export function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
