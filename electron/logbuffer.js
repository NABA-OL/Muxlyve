// Desarrollado por NABA-OL
// Captura console.log/error/warn en un buffer en memoria + archivo rotativo en userData,
// para poder adjuntar las últimas líneas a un reporte de error sin que el usuario tenga
// que abrir una terminal (la app empaquetada no muestra consola).
import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';

const MAX_LINES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB antes de rotar
const buffer = [];
let logPath = null;

function safeStringify(x) {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

function push(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ` + args.map(safeStringify).join(' ');
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.shift();
  if (logPath) {
    try { appendFileSync(logPath, line + '\n'); } catch { /* disco lleno u otro problema — no bloquea la app */ }
  }
}

export function initLogBuffer() {
  const dir = path.join(app.getPath('userData'), 'logs');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  logPath = path.join(dir, 'muxlyve.log');
  try {
    if (existsSync(logPath) && statSync(logPath).size > MAX_FILE_BYTES) {
      renameSync(logPath, logPath + '.old');
    }
  } catch {}

  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => { push('LOG', args); orig.log(...args); };
  console.error = (...args) => { push('ERROR', args); orig.error(...args); };
  console.warn = (...args) => { push('WARN', args); orig.warn(...args); };
}

// Trunca desde el final (las líneas más recientes son las más útiles para diagnosticar).
export function getRecentLog(maxChars = 50000) {
  const text = buffer.join('\n');
  return text.length > maxChars ? text.slice(-maxChars) : text;
}
