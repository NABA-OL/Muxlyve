// Desarrollado por BlacKraken Solutions (NABA-OL)
// Valida config/destinations.json sin exponer las claves.
// Uso: npm run validate
import { loadAll, isValidUrl } from '../src/destinations.js';

const HOST_HINTS = {
  Twitch: /twitch\.tv/i,
  Kick: /(kick\.com|live-video\.net)/i,
  YouTube: /youtube\.com/i,
  TikTok: /tiktok/i,
};
const MIN_KEY_LEN = 8;

function inspect(dest) {
  const url = (dest.url || '').trim();
  const problems = [];
  let scheme = '';
  let host = '';
  let keyLen = 0;

  const m = url.match(/^(rtmps?):\/\/([^/\s]+)(\/.*)?$/i);
  if (!m) {
    problems.push('no es rtmp(s):// válido o tiene espacios');
  } else {
    scheme = m[1].toLowerCase();
    host = m[2];
    const seg = (m[3] || '').split('/').filter(Boolean);
    keyLen = seg.length ? seg[seg.length - 1].length : 0;
    if (seg.length < 2) problems.push('falta clave al final (formato /app/CLAVE)');
    if (dest.enabled && keyLen < MIN_KEY_LEN) problems.push(`clave muy corta (${keyLen} chars)`);
  }
  if (dest.enabled && !isValidUrl(url)) problems.push('placeholder sin reemplazar o esquema inválido');
  const hint = HOST_HINTS[dest.name];
  if (hint && url && !hint.test(url)) problems.push(`host no parece de ${dest.name}`);

  return { scheme, host, keyLen, problems };
}

const destinations = loadAll();
let anyError = false;

for (const dest of destinations) {
  const { scheme, host, keyLen, problems } = inspect(dest);
  const verdict = problems.length ? `✗ ${problems.join('; ')}` : '✓ OK';
  if (problems.length && dest.enabled) anyError = true;
  console.log(
    dest.name.padEnd(8),
    `| on:${dest.enabled ? 'sí' : 'no'}`.padEnd(7),
    `| ${scheme.padEnd(5)}`,
    `| host: ${(host || '-').padEnd(34)}`,
    `| clave: ${(keyLen ? keyLen + ' chars' : '-').padEnd(9)}`,
    `| ${verdict}`,
  );
}

// Solo falla (exit 1) si un destino ACTIVO está mal: los apagados con placeholder son normales (p.ej. TikTok).
process.exit(anyError ? 1 : 0);
