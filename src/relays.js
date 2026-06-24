import { spawn } from 'node:child_process';
import { isPlayable } from './destinations.js';

// Gestor de procesos FFmpeg. Mantiene un relay por destino y la URL de origen
// mientras OBS publica, de modo que activar/desactivar un destino en caliente
// arranque o pare su reenvío al instante.
const relays = new Map(); // name -> ChildProcess
let sourceUrl = null; // URL del ingest local mientras hay emisión; null si no.

function maskUrl(url) {
  return url.replace(/\/[^/]+$/, '/****');
}

export function isLive() {
  return sourceUrl !== null;
}

export function isRelaying(name) {
  return relays.has(name);
}

function startRelay(dest) {
  if (!sourceUrl || relays.has(dest.name)) return;
  // -c copy = reenvio sin recodificar (carga minima de CPU)
  const args = [
    '-rw_timeout', '5000000',
    '-i', sourceUrl,
    '-c', 'copy',
    '-f', 'flv',
    dest.url,
  ];
  const proc = spawn('ffmpeg', args);
  proc.on('error', (err) => {
    console.error(`[relay:${dest.name}] no se pudo lanzar ffmpeg: ${err.message}`);
    relays.delete(dest.name);
  });
  proc.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[ffmpeg:${dest.name}] ${line.split('\n').pop()}`);
  });
  proc.on('close', (code) => {
    console.log(`[relay:${dest.name}] cerrado (code ${code})`);
    relays.delete(dest.name);
  });
  relays.set(dest.name, proc);
  console.log(`[relay:${dest.name}] iniciado -> ${maskUrl(dest.url)}`);
}

function stopRelay(name) {
  const proc = relays.get(name);
  if (!proc) return;
  proc.kill('SIGKILL');
  relays.delete(name);
  console.log(`[relay:${name}] detenido`);
}

// OBS empezó a publicar: guarda el origen y arranca todos los destinos reproducibles.
export function onPublish(url, destinations) {
  sourceUrl = url;
  destinations.filter(isPlayable).forEach(startRelay);
}

// OBS dejó de publicar: para todo y olvida el origen.
export function onUnpublish() {
  for (const name of relays.keys()) stopRelay(name);
  sourceUrl = null;
}

// Aplica un cambio de un destino en caliente:
//  - habilitado + válido y no corre -> arranca
//  - deshabilitado/ inválido y corre -> para
// Sin emisión activa no hace nada (se aplicará en el próximo onPublish).
export function applyChange(dest) {
  if (!isLive()) return;
  const running = relays.has(dest.name);
  if (isPlayable(dest) && !running) startRelay(dest);
  else if (!isPlayable(dest) && running) stopRelay(dest.name);
}

// El destino cambió de nombre o se borró: para el relay viejo por su nombre anterior.
export function stopByName(name) {
  stopRelay(name);
}
