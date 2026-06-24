import NodeMediaServer from 'node-media-server';
import { loadAll, isPlayable } from './destinations.js';
import { onPublish, onUnpublish } from './relays.js';
import { startPanel } from './panel.js';

const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const HTTP_PORT = Number(process.env.HTTP_PORT || 8000);
const PANEL_PORT = Number(process.env.PANEL_PORT || 8080);
const STREAM_KEY = process.env.STREAM_KEY || 'mistream';

const config = {
  rtmp: { port: RTMP_PORT, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
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
    console.warn('[ingest] OBS conectado pero NO hay destinos activos. Actívalos en el panel.');
    return;
  }
  console.log(`[ingest] OBS conectado. Reenviando a ${active.length} destino(s).`);
  // Pequeño delay para que el stream de origen esté listo antes de leerlo.
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
});

console.log('============================================');
console.log(' Multi_Stream — motor de retransmision');
console.log('============================================');
console.log(` Ingest RTMP:  rtmp://localhost:${RTMP_PORT}/live`);
console.log(` Clave OBS:    ${STREAM_KEY}`);
console.log(` API HTTP:     http://localhost:${HTTP_PORT}`);
console.log(' Edita destinos en el panel web.');
console.log('============================================');

process.on('SIGINT', () => { onUnpublish(); process.exit(0); });
process.on('SIGTERM', () => { onUnpublish(); process.exit(0); });
