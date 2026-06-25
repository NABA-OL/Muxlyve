import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { isPlayable } from './destinations.js';

// Ruta al binario de FFmpeg. Prioridad:
//  1. FFMPEG_PATH (override explícito).
//  2. ffmpeg-static (binario empaquetado dentro de la app de escritorio).
//  3. 'ffmpeg' del PATH del sistema (modo servidor / desarrollo sin Electron).
// Empaquetado con electron-builder, ffmpeg-static queda en app.asar.unpacked.
function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const require = createRequire(import.meta.url);
    const p = require('ffmpeg-static');
    if (p) return p.replace('app.asar', 'app.asar.unpacked');
  } catch {
    // ffmpeg-static no instalado: caemos al ffmpeg del sistema.
  }
  return 'ffmpeg';
}

const FFMPEG = resolveFfmpeg();

// Gestor de procesos FFmpeg con reconexión automática.
// Cada destino: name -> { proc, status, attempts, timer, stopping, startedAt, metrics }
// Estados: connecting | live | reconnecting | failed | stopped
const relays = new Map();
let sourceUrl = null; // URL del ingest local mientras hay emisión; null si no.
let liveSince = null; // timestamp del inicio del directo (uptime).

const MAX_ATTEMPTS = 6;
const BASE_DELAY = 2000; // ms
const MAX_DELAY = 30000; // tope del backoff
const STABLE_MS = 15000; // vivo este tiempo sin morir => resetea intentos
const LAG_SPEED = 0.85; // speed < 0.85x sostenido => rezagado
const STALE_MS = 6000; // sin progreso este tiempo => rezagado

function maskUrl(url) {
  return url.replace(/\/[^/]+$/, '/****');
}

export function isLive() {
  return sourceUrl !== null;
}

export function uptimeSeconds() {
  return liveSince ? Math.floor((Date.now() - liveSince) / 1000) : null;
}

// Info por destino para el panel (estado, intentos, métricas, rezago).
export function relayInfo(name) {
  const r = relays.get(name);
  if (!r) return { status: 'stopped', attempts: 0, metrics: null, lagging: false };
  const lagging =
    r.status === 'live' &&
    r.metrics != null &&
    ((typeof r.metrics.speed === 'number' && r.metrics.speed < LAG_SPEED) ||
      Date.now() - r.metrics.lastUpdate > STALE_MS);
  return { status: r.status, attempts: r.attempts, metrics: r.metrics, lagging };
}

// Extrae fps/bitrate/speed de las líneas de progreso de FFmpeg y marca el relay como 'live'.
function parseProgress(name, line) {
  const r = relays.get(name);
  if (!r) return;
  const fps = line.match(/fps=\s*([\d.]+)/);
  const br = line.match(/bitrate=\s*([\d.]+)\s*kbits\/s/i);
  const sp = line.match(/speed=\s*([\d.]+)\s*x/);
  if (!fps && !br && !sp) return; // no es línea de progreso

  r.status = 'live';
  r.metrics = {
    fps: fps ? Number(fps[1]) : r.metrics?.fps ?? null,
    bitrate: br ? Number(br[1]) : r.metrics?.bitrate ?? null,
    speed: sp ? Number(sp[1]) : r.metrics?.speed ?? null,
    lastUpdate: Date.now(),
  };
  // Reset de intentos tras estabilidad: una caída puntual no agota el presupuesto.
  if (r.attempts > 0 && Date.now() - r.startedAt > STABLE_MS) r.attempts = 0;
}

function startRelay(dest) {
  if (!sourceUrl) return;
  const prev = relays.get(dest.name);
  if (prev && (prev.status === 'connecting' || prev.status === 'live')) return; // ya corre

  // -c copy = reenvío sin recodificar (carga mínima de CPU)
  const fmt = dest.url.startsWith('srt://') ? 'mpegts' : 'flv';
  const args = ['-rw_timeout', '5000000', '-i', sourceUrl, '-c', 'copy', '-f', fmt, dest.url];
  const proc = spawn(FFMPEG, args);

  const entry = {
    proc,
    status: 'connecting',
    attempts: prev?.attempts ?? 0, // conserva el contador entre reintentos
    timer: null,
    stopping: false,
    startedAt: Date.now(),
    metrics: null,
  };
  relays.set(dest.name, entry);

  proc.on('error', (err) => {
    console.error(`[relay:${dest.name}] no se pudo lanzar ffmpeg: ${err.message}`);
  });
  proc.stderr.on('data', (d) => {
    for (const line of d.toString().split(/[\r\n]+/)) {
      if (!line.trim()) continue;
      parseProgress(dest.name, line);
      if (/error|failed|unable|refused|denied/i.test(line)) {
        console.log(`[ffmpeg:${dest.name}] ${line}`);
      }
    }
  });
  proc.on('close', (code) => onRelayClose(dest, code));

  console.log(`[relay:${dest.name}] iniciado -> ${maskUrl(dest.url)}`);
}

// Un relay murió: decide si fue parada manual, fin de emisión, o caída a reintentar.
function onRelayClose(dest, code) {
  const r = relays.get(dest.name);
  if (!r) return;
  if (r.stopping) { relays.delete(dest.name); return; } // parada intencional
  if (!isLive() || !isPlayable(dest)) { relays.delete(dest.name); return; }

  if (r.attempts >= MAX_ATTEMPTS) {
    r.status = 'failed';
    r.proc = null;
    r.metrics = null;
    console.error(`[relay:${dest.name}] agotados ${MAX_ATTEMPTS} intentos. Marcado como failed.`);
    return; // queda en el Map como 'failed' para que el panel lo muestre
  }
  const delay = Math.min(BASE_DELAY * 2 ** r.attempts, MAX_DELAY);
  r.attempts += 1;
  r.status = 'reconnecting';
  r.proc = null;
  r.metrics = null;
  console.warn(`[relay:${dest.name}] caído (code ${code}). Reintento ${r.attempts}/${MAX_ATTEMPTS} en ${delay}ms`);
  r.timer = setTimeout(() => startRelay(dest), delay);
}

function stopRelay(name) {
  const r = relays.get(name);
  if (!r) return;
  r.stopping = true; // distingue parada manual de caída
  if (r.timer) clearTimeout(r.timer);
  if (r.proc) r.proc.kill('SIGKILL');
  relays.delete(name);
  console.log(`[relay:${name}] detenido`);
}

// OBS empezó a publicar: guarda el origen y arranca todos los destinos reproducibles.
export function onPublish(url, destinations) {
  sourceUrl = url;
  liveSince = Date.now();
  destinations.filter(isPlayable).forEach(startRelay);
}

// OBS dejó de publicar: para todo y olvida el origen.
export function onUnpublish() {
  for (const name of [...relays.keys()]) stopRelay(name);
  sourceUrl = null;
  liveSince = null;
}

// Aplica un cambio de un destino en caliente. Sin emisión activa no hace nada.
export function applyChange(dest) {
  if (!isLive()) return;
  const r = relays.get(dest.name);
  const active = r && ['connecting', 'live', 'reconnecting'].includes(r.status);
  if (isPlayable(dest) && !active) retry(dest);
  else if (!isPlayable(dest) && r) stopRelay(dest.name);
}

// Reintento manual (botón del panel para destinos 'failed'): arranca limpio con attempts=0.
export function retry(dest) {
  if (!isLive() || !isPlayable(dest)) return;
  const r = relays.get(dest.name);
  if (r) {
    if (r.timer) clearTimeout(r.timer);
    if (r.proc) { r.stopping = true; r.proc.kill('SIGKILL'); }
  }
  relays.delete(dest.name); // entry nuevo => attempts arranca en 0
  startRelay(dest);
}

// El destino cambió de nombre o se borró: para el relay viejo por su nombre anterior.
export function stopByName(name) {
  stopRelay(name);
}
