import NodeMediaServer from 'node-media-server';
import { readFileSync } from 'node:fs';
import { loadAll, isPlayable } from './destinations.js';
import { onPublish, onUnpublish } from './relays.js';
import { startPanel } from './panel.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const RTMP_PORT = Number(process.env.RTMP_PORT || 19350);
const HTTP_PORT = Number(process.env.HTTP_PORT || 19000);
const PANEL_PORT = Number(process.env.PANEL_PORT || 19080);
const STREAM_KEY = process.env.STREAM_KEY || 'mistream';

const config = {
  // ping cada 10s, timeout en 15s: OBS que se cierra sin avisar se detecta ~15s después.
  rtmp: { port: RTMP_PORT, chunk_size: 60000, gop_cache: true, ping: 10, ping_timeout: 15 },
  http: { port: HTTP_PORT, allow_origin: '*' },
};

const nms = new NodeMediaServer(config);

nms.on('prePublish', (id, StreamPath) => {
  const key = StreamPath.split('/').pop();
  if (key !== STREAM_KEY) {
    console.warn(`[ingest] Clave invalida (${key}). Rechazando.`);
    nms.getSession(id).reject();
    return;
  }
  const sourceUrl = `rtmp://127.0.0.1:${RTMP_PORT}${StreamPath}`;
  const destinations = loadAll();
  const active = destinations.filter(isPlayable);
  if (active.length === 0) {
    console.warn('[ingest] OBS conectado. Sin destinos activos — actívalos en el panel para iniciar el reenvío.');
  } else {
    console.log(`[ingest] OBS conectado. Auto-iniciando ${active.length} destino(s).`);
  }
  // Siempre llama onPublish para que isLive() sea true y applyChange funcione
  // aunque el usuario encienda destinos DESPUÉS de que OBS ya esté conectado.
  setTimeout(() => onPublish(sourceUrl, destinations), 1500);
});

nms.on('donePublish', () => {
  console.log('[ingest] OBS desconectado. Deteniendo reenvios.');
  onUnpublish();
});

nms.run();
startPanel(PANEL_PORT, {
  rtmpUrl: `rtmp://localhost:${RTMP_PORT}/live`,
  streamKey: STREAM_KEY,
  // node-media-server expone el ingest como HTTP-FLV en su puerto HTTP.
  flvUrl: `http://localhost:${HTTP_PORT}/live/${STREAM_KEY}.flv`,
  version,
});

console.log('============================================');
console.log(' Muxlyve — motor de retransmision');
console.log('============================================');
console.log(` Ingest RTMP:  rtmp://localhost:${RTMP_PORT}/live`);
console.log(` Clave OBS:    ${STREAM_KEY}`);
console.log(` API HTTP:     http://localhost:${HTTP_PORT}`);
console.log(' Edita destinos en el panel web.');
console.log('============================================');

process.on('SIGINT', () => { onUnpublish(); process.exit(0); });
process.on('SIGTERM', () => { onUnpublish(); process.exit(0); });
