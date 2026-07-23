// Desarrollado por BlacKraken Solutions (NABA-OL)
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { isPlayable } from './destinations.js';
import { FFMPEG } from './ffmpeg.js';
import { startMonitor, stopMonitor } from './monitor.js';
import { loadSettings, saveSettings } from './settings.js';

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
  if (!r) return { status: 'stopped', attempts: 0, metrics: null, lagging: false, transcoding: false };
  const lagging =
    r.status === 'live' &&
    r.metrics != null &&
    ((typeof r.metrics.speed === 'number' && r.metrics.speed < LAG_SPEED) ||
      Date.now() - r.metrics.lastUpdate > STALE_MS);
  return { status: r.status, attempts: r.attempts, metrics: r.metrics, lagging, transcoding: !!r.transcoding };
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

// ── Bitrate máximo por destino (opcional) ───────────────────────────────────
// Por defecto TODO sigue en -c copy (sin cambios) — esto solo entra en juego si el
// destino tiene maxBitrate configurado. Ver plan: margen + sostenido + decisión única
// al arrancar (no anda alternando copy/transcode en caliente mid-stream).
const BITRATE_CHECK_SAMPLES = 6; // ~sostenido unos segundos antes de decidir, no un pico
const bitrateSamples = new Map(); // name -> number[] ventana corta para el chequeo
const transcodingDecided = new Set(); // nombres que ya decidieron recodificar esta sesión

function checkBitrateCap(dest) {
  if (!dest.maxBitrate || transcodingDecided.has(dest.name)) return;
  const r = relays.get(dest.name);
  if (!r?.metrics?.bitrate) return;
  const samples = bitrateSamples.get(dest.name) || [];
  samples.push(r.metrics.bitrate);
  if (samples.length > BITRATE_CHECK_SAMPLES) samples.shift();
  bitrateSamples.set(dest.name, samples);
  if (samples.length < BITRATE_CHECK_SAMPLES) return; // no hay suficiente historial todavía

  // Margen: el bitrate real de OBS fluctúa un poco alrededor del configurado (compresión
  // variable, jitter) — sin esto, un pico normal dispararía transcode innecesariamente.
  const margin = Math.max(dest.maxBitrate * 0.1, 500);
  const threshold = dest.maxBitrate + margin;
  if (samples.every((b) => b > threshold)) {
    bitrateSamples.delete(dest.name);
    switchToTranscode(dest);
  }
}

// Pasa ESTE destino puntual de -c copy a recodificar con el cap — implica reiniciar su
// proceso FFmpeg (corte breve de ese destino solo, los demás no se tocan). Se marca en
// transcodingDecided ANTES de reiniciar para que sobreviva reconexiones dentro de la
// misma sesión (no vuelve a copy solo hasta el próximo onUnpublish/onPublish).
function switchToTranscode(dest) {
  if (transcodingDecided.has(dest.name)) return;
  transcodingDecided.add(dest.name);
  console.log(`[relay:${dest.name}] bitrate sostenido por encima del cap (${dest.maxBitrate}k) — recodificando de ahora en más`);
  const r = relays.get(dest.name);
  if (r?.proc) {
    const proc = r.proc;
    proc.kill('SIGINT');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1500);
  }
  if (r) { r.stopping = true; if (r.timer) clearTimeout(r.timer); }
  relays.delete(dest.name);
  setTimeout(() => startRelay(dest), 400); // startRelay() consulta transcodingDecided para elegir los args
}

// Kick espera la stream key bajo la ruta /app (rtmps://host/app/<key>). El dashboard
// suele mostrar Server URL = ".../app" y Stream Key aparte; si el usuario pegó la key
// pegada tras el host sin /app, el servidor cierra el TLS con "End of file". Esta
// normalización inserta /app cuando falta en los hosts de Kick.
function normalizeKickUrl(url) {
  try {
    const u = new URL(url);
    if (/global-contribute\.live-video\.net$/i.test(u.hostname) && !u.pathname.startsWith('/app')) {
      const key = u.pathname.replace(/^\//, '');
      return `${u.protocol}//${u.host}/app/${key}`;
    }
  } catch {
    return url;
  }
  return url;
}

function startRelay(dest) {
  if (!sourceUrl) return;
  const prev = relays.get(dest.name);
  if (prev && (prev.status === 'connecting' || prev.status === 'live')) return; // ya corre

  // -c copy = reenvío sin recodificar (carga mínima de CPU) — el caso normal, para
  // TODOS los destinos salvo que tengan maxBitrate Y ya se haya decidido recodificar
  // (ver checkBitrateCap/switchToTranscode). Sin cap configurado, nunca cambia.
  const fmt = dest.url.startsWith('srt://') ? 'mpegts' : 'flv';
  const targetUrl = normalizeKickUrl(dest.url);
  const useTranscode = !!dest.maxBitrate && transcodingDecided.has(dest.name);
  const args = useTranscode
    ? ['-rw_timeout', '5000000', '-i', sourceUrl,
       '-c:v', 'libx264', '-preset', 'veryfast',
       '-b:v', `${dest.maxBitrate}k`, '-maxrate', `${dest.maxBitrate}k`, '-bufsize', `${dest.maxBitrate * 2}k`,
       '-c:a', 'copy', '-f', fmt, targetUrl]
    : ['-rw_timeout', '5000000', '-i', sourceUrl, '-c', 'copy', '-f', fmt, targetUrl];
  const proc = spawn(FFMPEG, args);

  const entry = {
    proc,
    status: 'connecting',
    attempts: prev?.attempts ?? 0, // conserva el contador entre reintentos
    timer: null,
    stopping: false,
    startedAt: Date.now(),
    metrics: null,
    transcoding: useTranscode,
  };
  relays.set(dest.name, entry);

  proc.on('error', (err) => {
    console.error(`[relay:${dest.name}] no se pudo lanzar ffmpeg: ${err.message}`);
  });
  proc.stderr.on('data', (d) => {
    for (const line of d.toString().split(/[\r\n]+/)) {
      if (!line.trim()) continue;
      parseProgress(dest.name, line);
      if (dest.maxBitrate && !useTranscode) checkBitrateCap(dest);
      if (/error|failed|unable|refused|denied/i.test(line)) {
        console.log(`[ffmpeg:${dest.name}] ${line}`);
      }
    }
  });
  proc.on('close', (code) => onRelayClose(dest, code));

  console.log(`[relay:${dest.name}] iniciado${useTranscode ? ` (recodificando a ${dest.maxBitrate}kbps)` : ''} -> ${maskUrl(dest.url)}`);
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
  if (r.proc) {
    const proc = r.proc;
    // SIGINT (no SIGKILL): le da a ffmpeg oportunidad de cerrar la conexión RTMP en limpio
    // y vaciar lo último que tenga en el buffer de salida, en vez de cortar en seco a mitad
    // de un frame/paquete. Con -c copy el cierre es casi instantáneo, así que 2s de margen
    // alcanza de sobra; si por lo que sea no salió solo, ahí sí SIGKILL de respaldo.
    proc.kill('SIGINT');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
  }
  relays.delete(name);
  console.log(`[relay:${name}] detenido`);
}

// OBS empezó a publicar: guarda el origen y arranca todos los destinos reproducibles.
export function onPublish(url, destinations) {
  sourceUrl = url;
  liveSince = Date.now();
  destinations.filter(isPlayable).forEach(startRelay);
  startMonitor(url); // métricas del ingest + niveles de audio
  // Buffer/grabación completa "armados" (prendidos sin señal, ver arm*() más abajo) —
  // arrancan solos apenas hay con qué. Server-side a propósito: funciona igual sea el
  // panel o el plugin de Stream Deck quien lo haya armado.
  const settings = loadSettings();
  if (settings.recArmed && !recProc) startRecording(recDuration);
  if (settings.fullRecArmed && !fullRecProc) startFullRecording();
}

// OBS dejó de publicar: para todo y olvida el origen.
export function onUnpublish() {
  for (const name of [...relays.keys()]) stopRelay(name);
  stopRecording();
  stopFullRecording();
  stopMonitor();
  sourceUrl = null;
  liveSince = null;
  // Nueva sesión = nueva evaluación de bitrate desde cero (el bitrate de OBS pudo cambiar).
  transcodingDecided.clear();
  bitrateSamples.clear();
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

// ── Grabador de buffer rodante ────────────────────────────────────────────
// Escribe segmentos de 10s en un directorio temporal con wrap circular.
// Cuando el usuario pide "guardar clip", concatenamos los últimos N segmentos en un MP4.
// En Linux, tmpdir() (/tmp) suele estar montado como tmpfs (RAM), a diferencia de
// Mac/Windows donde es disco real — un buffer largo ahí consumiría RAM en vez de disco.
// REC_DIR es overrideable (mismo criterio que MS_CONFIG_DIR en destinations.js) para
// poder apuntarlo a disco real si hace falta; el default en Linux ya evita tmpfs solo.
const REC_DIR = process.env.REC_DIR || (process.platform === 'linux'
  ? path.join(homedir(), '.cache', 'muxlyve', 'ms_rec')
  : path.join(tmpdir(), 'ms_rec'));
const SEG_SECS = 10;

let recProc     = null;
let recDuration = 60; // 30 | 60 | 120

export function recorderInfo() {
  return { active: recProc !== null, duration: recDuration, armed: loadSettings().recArmed };
}

// Arma/desarma el buffer para que arranque solo en el próximo onPublish() si no hay
// señal todavía — llamado tanto desde el toggle del panel como desde el plugin de
// Stream Deck (mismos endpoints /api/record/start|stop, ver panel.js).
export function armRecording(armed) {
  saveSettings({ recArmed: !!armed });
}

export function startRecording(durationSecs) {
  if (!sourceUrl) return; // sin emisión activa no hay nada que grabar
  if (recProc) stopRecording();
  recDuration = durationSecs || 60;
  mkdirSync(REC_DIR, { recursive: true });
  const wrap = Math.ceil(recDuration / SEG_SECS) + 2; // segmentos extra de margen
  const proc = spawn(FFMPEG, [
    '-i', sourceUrl,
    '-c', 'copy',
    '-f', 'segment',
    '-segment_time', String(SEG_SECS),
    '-segment_wrap', String(wrap),
    '-reset_timestamps', '1',
    path.join(REC_DIR, 'seg%d.ts'),
  ]);
  recProc = proc;
  proc.stderr.on('data', () => {}); // drain: no loguear progreso del grabador
  proc.on('exit', () => { if (recProc === proc) recProc = null; });
  console.log(`[recorder] buffer iniciado (${recDuration}s)`);
}

export function stopRecording() {
  if (!recProc) return;
  recProc.kill('SIGKILL');
  recProc = null;
  console.log('[recorder] buffer detenido');
}

// ── Grabación completa local ──────────────────────────────────────────────
// Distinta del buffer rodante de arriba: un solo archivo con TODA la transmisión,
// mientras dure. Graba a .ts (no .mp4 directo) a propósito — MPEG-TS no depende de
// un índice final (moov atom) como MP4, así que un cierre abrupto (crash, forzar
// cierre de la app, kill -9) deja igual un archivo completo y reproducible. Al
// terminar el proceso (parada normal o no) se remuxea a .mp4 en segundo plano
// (-c copy, sin recodificar); si el remux falla, el .ts queda intacto — la
// grabación nunca se pierde en ningún escenario.
let fullRecProc = null;
let fullRecStartedAt = null;

export function fullRecordingInfo() {
  return { active: fullRecProc !== null, startedAt: fullRecStartedAt, armed: loadSettings().fullRecArmed };
}

export function armFullRecording(armed) {
  saveSettings({ fullRecArmed: !!armed });
}

export function startFullRecording(outputDir) {
  if (!sourceUrl || fullRecProc) return;
  const dir = resolveRecordingsDir(outputDir);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tsFile = path.join(dir, `grabacion_${ts}.ts`);
  const proc = spawn(FFMPEG, ['-i', sourceUrl, '-c', 'copy', tsFile]);
  fullRecProc = proc;
  fullRecStartedAt = Date.now();
  proc.stderr.on('data', () => {}); // drain, igual que el buffer rodante
  proc.on('exit', () => {
    if (fullRecProc === proc) { fullRecProc = null; fullRecStartedAt = null; }
    const mp4File = tsFile.replace(/\.ts$/, '.mp4');
    execFile(FFMPEG, ['-y', '-i', tsFile, '-c', 'copy', mp4File], (err) => {
      if (!err) { try { unlinkSync(tsFile); } catch {} }
      else console.error('[fullrec] no se pudo remuxear a mp4 (el .ts queda intacto):', err.message);
    });
  });
  console.log('[fullrec] grabación completa iniciada');
}

export function stopFullRecording() {
  if (!fullRecProc) return;
  fullRecProc.kill('SIGKILL'); // el remux a mp4 corre en el handler 'exit' de arriba
  console.log('[fullrec] grabación completa detenida');
}

// Carpeta base por defecto (auto-creada en el primer uso): ~/Movies/Muxlyve (Mac) o
// ~/Videos/Muxlyve (Windows). Clips y grabaciones completas quedan en subcarpetas
// separadas — mismo folder base, pero se distinguen a simple vista en el Finder/Explorer.
function defaultMediaBase() {
  const videosFolder = process.platform === 'darwin' ? 'Movies' : 'Videos';
  return path.join(homedir(), videosFolder, 'Muxlyve');
}

// Mismo folder para guardar y para listar/abrir — un solo lugar donde vive esta cuenta.
export function resolveClipsDir(outputDir) {
  return outputDir || process.env.MS_CLIPS_DIR || path.join(defaultMediaBase(), 'Clips');
}

// Folder de la grabación completa — configurable aparte de resolveClipsDir(), para que
// clips (buffer rodante) y grabaciones (archivo único de toda la transmisión) no se
// mezclen en la misma carpeta ni haya que compartir el mismo ajuste para ambas cosas.
export function resolveRecordingsDir(outputDir) {
  return outputDir || process.env.MS_RECORDINGS_DIR || path.join(defaultMediaBase(), 'Grabaciones');
}

// Últimos clips guardados en el folder configurado, para mostrar en el panel.
export function listRecentClips(outputDir, limit = 6) {
  const dir = resolveClipsDir(outputDir);
  let files = [];
  try {
    files = readdirSync(dir)
      .filter(f => /^clip_.*\.mp4$/.test(f))
      .map(f => {
        const p = path.join(dir, f);
        const st = statSync(p);
        return { name: f, path: p, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch { files = []; }
  return { dir, files };
}

// Últimas grabaciones completas ya remuxeadas a .mp4 (mismo criterio que listRecentClips,
// pero apuntando a resolveRecordingsDir() y al prefijo grabacion_ en vez de clip_). Los
// .ts que todavía no terminaron de remuxear no aparecen acá a propósito — recién listos
// cuando ya son .mp4 reproducibles.
export function listRecentRecordings(outputDir, limit = 6) {
  const dir = resolveRecordingsDir(outputDir);
  let files = [];
  try {
    files = readdirSync(dir)
      .filter(f => /^grabacion_.*\.mp4$/.test(f))
      .map(f => {
        const p = path.join(dir, f);
        const st = statSync(p);
        return { name: f, path: p, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch { files = []; }
  return { dir, files };
}

export function saveClip(durationSecs, outputDir) {
  const dur = durationSecs || recDuration;
  const numSegs = Math.ceil(dur / SEG_SECS) + 1;

  let files = [];
  try {
    files = readdirSync(REC_DIR)
      .filter(f => /^seg\d+\.ts$/.test(f))
      .map(f => { const p = path.join(REC_DIR, f); return { p, mtime: statSync(p).mtimeMs }; })
      .sort((a, b) => a.mtime - b.mtime)
      .slice(-numSegs)
      .map(f => f.p);
  } catch { files = []; }

  if (!files.length) return Promise.reject(new Error('Sin segmentos. Espera unos segundos tras activar el buffer.'));

  const clipsDir = resolveClipsDir(outputDir);
  mkdirSync(clipsDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(clipsDir, `clip_${ts}.mp4`);

  // FFmpeg espera rutas con / en la lista de concat (incluso en Windows)
  const listFile = path.join(REC_DIR, 'concat.txt');
  writeFileSync(listFile, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8');

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-y', outFile,
    ]);
    proc.stderr.on('data', () => {});
    proc.on('exit', code => code === 0 ? resolve(outFile) : reject(new Error('FFmpeg error al exportar (code ' + code + ')')));
  });
}
