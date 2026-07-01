// Desarrollado por NABA-OL
// Monitor del ingest: un único proceso FFmpeg lee el stream local y reporta
//  - resolución + fps RECIBIDOS (banner de entrada, parseado una vez)
//  - niveles de audio L/R en tiempo real, computados de PCM crudo en Node
// Decodifica solo audio a PCM 8 kHz estéreo (-vn) => ~1% CPU. Arranca/para con la emisión.
// -flush_packets 1 fuerza salida en vivo (sin él, el pipe queda block-buffered).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { FFMPEG } from './ffmpeg.js';

export const audioBus = new EventEmitter(); // emite 'level' { l, r }

let proc = null;
let videoInfo = null; // { width, height, fps } — del banner de entrada
let lastAudio = { l: 0, r: 0 };
let lastEmit = 0;
let pcmRemainder = Buffer.alloc(0);

const EMIT_THROTTLE_MS = 60; // tope ~16 Hz para no inundar SSE
const DB_FLOOR = -60;        // dBFS que mapea a 0%
const INT16_MAX = 32768;

// dBFS (negativo, 0 = máximo) -> porcentaje 0..100
function dbToPct(db) {
  if (db <= DB_FLOOR || Number.isNaN(db)) return 0;
  if (db >= 0) return 100;
  return Math.round(((db - DB_FLOOR) / -DB_FLOOR) * 100);
}

// Amplitud de pico (0..32768) -> porcentaje vía dBFS
function ampToPct(peak) {
  if (peak <= 0) return 0;
  return dbToPct(20 * Math.log10(peak / INT16_MAX));
}

// Banner de entrada de FFmpeg (stderr): "... Video: h264 ... 1280x720 ... 30 fps ..."
function parseBanner(line) {
  if (videoInfo || !line.includes('Video:')) return;
  const res = line.match(/(\d{2,5})x(\d{2,5})/);
  const fps = line.match(/([\d.]+)\s*fps/);
  if (!res) return;
  videoInfo = {
    width: Number(res[1]),
    height: Number(res[2]),
    fps: fps ? Math.round(Number(fps[1])) : null,
  };
}

function emitLevel() {
  const now = Date.now();
  if (now - lastEmit < EMIT_THROTTLE_MS) return;
  lastEmit = now;
  audioBus.emit('level', lastAudio);
}

// PCM s16le interleaved estéreo [L,R,L,R,...]: pico por canal en el chunk.
function processPcm(chunk) {
  const buf = pcmRemainder.length ? Buffer.concat([pcmRemainder, chunk]) : chunk;
  const frames = Math.floor(buf.length / 4); // 4 bytes por par L+R
  let peakL = 0, peakR = 0;
  for (let i = 0; i < frames; i++) {
    const l = Math.abs(buf.readInt16LE(i * 4));
    const r = Math.abs(buf.readInt16LE(i * 4 + 2));
    if (l > peakL) peakL = l;
    if (r > peakR) peakR = r;
  }
  pcmRemainder = buf.subarray(frames * 4); // bytes sobrantes (< 4) al siguiente chunk
  if (frames === 0) return;
  lastAudio = { l: ampToPct(peakL), r: ampToPct(peakR) };
  emitLevel();
}

export function startMonitor(sourceUrl) {
  if (proc || !sourceUrl) return;
  videoInfo = null;
  pcmRemainder = Buffer.alloc(0);
  const args = [
    '-rw_timeout', '5000000',
    '-i', sourceUrl,
    '-vn',                      // ignora video (la resolución/fps salen del banner)
    '-ac', '2', '-ar', '8000',  // estéreo 8 kHz: suficiente para medir nivel, mínimo ancho de banda
    '-f', 's16le',
    '-flush_packets', '1',      // salida en vivo, sin buffer de bloque
    'pipe:1',
  ];
  const p = spawn(FFMPEG, args);
  proc = p;
  p.on('error', (err) => console.error('[monitor] no se pudo lanzar ffmpeg:', err.message));
  p.stdout.on('data', processPcm);
  p.stderr.on('data', (d) => {
    for (const line of d.toString().split(/[\r\n]+/)) {
      if (line.trim()) parseBanner(line);
    }
  });
  p.on('close', () => { if (proc === p) { proc = null; videoInfo = null; } });
  console.log('[monitor] iniciado sobre el ingest');
}

export function stopMonitor() {
  if (!proc) return;
  proc.kill('SIGKILL');
  proc = null;
  videoInfo = null;
  lastAudio = { l: 0, r: 0 };
}

// Stats del ingest para /api/state.
export function ingestInfo() {
  return videoInfo; // { width, height, fps } o null
}

// ── Self-check (node src/monitor.js --selftest) ─────────────────────────────
if (process.argv[1]?.endsWith('monitor.js') && process.argv.includes('--selftest')) {
  const assert = (c, msg) => { if (!c) { console.error('FALLO:', msg); process.exit(1); } };

  // Banner de entrada
  parseBanner('  Stream #0:1: Video: h264, yuv420p, 1280x720 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr');
  assert(videoInfo.width === 1280 && videoInfo.height === 720 && videoInfo.fps === 30, 'banner 1280x720@30');

  // dBFS de referencia
  assert(ampToPct(INT16_MAX - 1) === 100, 'pico máximo => 100%');
  assert(ampToPct(0) === 0, 'silencio => 0%');
  assert(ampToPct(16384) === 90, 'mitad de escala (-6dBFS) => 90%');

  // PCM: 3 frames estéreo con picos L=16384, R=32767
  const buf = Buffer.alloc(12);
  buf.writeInt16LE(100, 0);   buf.writeInt16LE(-200, 2);  // frame 0
  buf.writeInt16LE(16384, 4); buf.writeInt16LE(32767, 6); // frame 1 (picos)
  buf.writeInt16LE(-50, 8);   buf.writeInt16LE(0, 10);    // frame 2
  processPcm(buf);
  assert(lastAudio.l === 90, 'PCM pico L 16384 => 90%, got ' + lastAudio.l);
  assert(lastAudio.r === 100, 'PCM pico R 32767 => 100%, got ' + lastAudio.r);

  // Chunk partido a mitad de un sample (3 bytes sueltos): se guarda el resto
  lastAudio = { l: 0, r: 0 };
  processPcm(Buffer.from([0x00, 0x40, 0xFF])); // 0x4000=16384 en L, 1 byte suelto
  assert(pcmRemainder.length === 3, 'sin frame completo => 3 bytes en remainder, got ' + pcmRemainder.length);
  processPcm(Buffer.from([0x7F, 0x00, 0x00])); // completa: R=0x007F... -> arma frame
  assert(pcmRemainder.length === 2, 'reensambla cruzando chunks, sobran 2 bytes');

  console.log('monitor.js self-check OK');
  process.exit(0);
}
