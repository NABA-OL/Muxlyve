// Desarrollado por NABA-OL
// Genera electron/oauth-credentials.js (gitignored) a partir de .env, para hornear
// los client IDs/secret dentro del binario empaquetado. Se ejecuta antes de cada build
// (predist/predist:mac/predist:publish) — nunca se commitea a git.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const outPath = path.join(root, 'electron', 'oauth-credentials.js');

function loadEnv() {
  const env = {};
  if (!existsSync(envPath)) return env;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const keys = ['TWITCH_CLIENT_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
const missing = keys.filter((k) => !env[k]);
if (missing.length) {
  console.error(`[oauth-credentials] ERROR: falta en .env: ${missing.join(', ')}`);
  console.error('[oauth-credentials] Esta máquina de build no tiene el .env con las credenciales reales');
  console.error('[oauth-credentials] (.env está gitignored — no viaja con git clone/pull). Copia el .env');
  console.error('[oauth-credentials] con los valores reales a la raíz del proyecto ANTES de compilar,');
  console.error('[oauth-credentials] o el instalador quedará con OAuth roto para esa(s) plataforma(s).');
  process.exit(1);
}

const body = `// AUTO-GENERADO por scripts/generate-oauth-credentials.mjs — NO editar a mano, NO commitear.
export const BUNDLED = ${JSON.stringify(
  Object.fromEntries(keys.map((k) => [k, env[k] || ''])),
  null,
  2,
)};
`;

writeFileSync(outPath, body);
console.log('[oauth-credentials] electron/oauth-credentials.js generado.');
