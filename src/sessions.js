// Propiedad de BlacKraken Solutions
// Desarrollado por NABA-OL
// Historial de sesiones de transmisión — un registro por vez que la app avisó "estoy en
// vivo" de verdad (mismo criterio que el webhook de inicio/fin, ver relays.js
// onUnpublish(): si nunca se avisó el inicio, tampoco se guarda un registro — sería una
// entrada de "transmitiste" para algo que nunca llegó a conectar con ninguna plataforma).
// JSON plano en MS_CONFIG_DIR, mismo patrón que destinations.js/settings.js/presets.js.
// 100% local — nada de esto sale de la máquina del usuario, no es telemetría ni analytics
// de terceros.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Función, no const — ver el mismo fix en settings.js (settingsPath()) para el porqué:
// una const calculada al importar puede quedar pegada a la ruta de fallback dentro del
// .asar si algo llega a importar este módulo antes de que main.js fije MS_CONFIG_DIR.
function sessionsPath() {
  const configDir = process.env.MS_CONFIG_DIR || path.join(__dirname, '..', 'config');
  return path.join(configDir, 'sessions.json');
}

// Tope simple por CANTIDAD, no por fecha ("últimas 100" en vez de "últimos 90 días") —
// más fácil de razonar y de podar: no hace falta comparar timestamps contra "hoy" en
// cada guardado, alcanza con recortar el array.
export const MAX_SESSIONS = 100;

function validSession(s) {
  return !!s && typeof s === 'object'
    && typeof s.startedAt === 'number'
    && typeof s.endedAt === 'number'
    && typeof s.durationSeconds === 'number'
    && Array.isArray(s.destinations);
}

// Cualquier entrada mal formada se descarta sin avisar — mismo criterio que
// validPresets()/validDiscordWebhooks() en settings.js: el archivo lo puede haber editado
// el usuario a mano, nunca se confía en su forma.
export function listSessions() {
  const sessionsPathValue = sessionsPath();
  if (!existsSync(sessionsPathValue)) return [];
  try {
    const data = JSON.parse(readFileSync(sessionsPathValue, 'utf-8'));
    if (!Array.isArray(data)) return [];
    return data.filter(validSession);
  } catch (err) {
    console.error('[sessions] No se pudo leer sessions.json:', err.message);
    return [];
  }
}

// Agrega un registro nuevo AL PRINCIPIO (más reciente primero — así listSessions() ya
// devuelve el orden que quiere la UI, sin invertir del lado del cliente) y poda al tope.
// "Append-only" en el sentido de que un registro viejo nunca se edita, no en el sentido
// de "siempre al final del archivo".
export function recordSession(entry) {
  const next = [entry, ...listSessions()].slice(0, MAX_SESSIONS);
  writeFileSync(sessionsPath(), JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return next;
}
