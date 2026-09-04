/*
 * Propiedad de BlacKraken Solutions <blackraken.com>
 * Desarrollado por: NABAOL
 * Fecha de creación: 2026-07-01
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
import NodeMediaServer from 'node-media-server';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { loadAll, isPlayable, isPlayableVertical } from './destinations.js';
import { onPublish, onUnpublish, onPublishVertical, onUnpublishVertical } from './relays.js';
import { startPanel } from './panel.js';
import { loadSettings } from './settings.js';
import { initChatCommands } from './chatcommands.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// ponytail: primera IPv4 no interna encontrada — si hay varias interfaces (Wi-Fi + Ethernet),
// toma la primera; ampliar a listar todas si algún usuario lo necesita.
function getLanIp() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}
const LAN_IP = getLanIp();

const RTMP_PORT = Number(process.env.RTMP_PORT || 19350);
const HTTP_PORT = Number(process.env.HTTP_PORT || 19000);
const PANEL_PORT = Number(process.env.PANEL_PORT || 19080);
// Snapshot solo para el log de arranque y como valor inicial del panel — la
// validación real en prePublish llama loadSettings() de nuevo en cada intento, así el
// usuario puede cambiar la clave desde el panel sin reiniciar la app (ver settings.js).
const STREAM_KEY = loadSettings().streamKey;

const config = {
  // ping cada 10s, timeout en 15s: OBS que se cierra sin avisar se detecta ~15s después.
  rtmp: { port: RTMP_PORT, chunk_size: 60000, gop_cache: true, ping: 10, ping_timeout: 15 },
  http: { port: HTTP_PORT, allow_origin: '*' },
};

const nms = new NodeMediaServer(config);

// Sufijo que distingue el ingest VERTICAL del horizontal — misma clave de siempre más este
// sufijo, sin ajuste nuevo que pedirle al usuario (ver CLAUDE.md "Dual-format vertical").
// OBS manda esto como una SEGUNDA conexión RTMP totalmente aparte (segunda salida en OBS,
// ej. Aitum Vertical Canvas como output normal) — no tiene nada que ver con la feature
// nativa "Video multipista" de OBS, que quedó descartada por depender de GPU específica y
// de que el servicio esté en la whitelist de OBS.
const VERTICAL_SUFFIX = '-vertical';

nms.on('prePublish', (id, StreamPath) => {
  const key = StreamPath.split('/').pop();
  const streamKey = loadSettings().streamKey;
  const isVertical = key === `${streamKey}${VERTICAL_SUFFIX}`;
  if (key !== streamKey && !isVertical) {
    console.warn(`[ingest] Clave invalida (${key}). Rechazando.`);
    nms.getSession(id).reject();
    return;
  }
  const sourceUrl = `rtmp://127.0.0.1:${RTMP_PORT}${StreamPath}`;
  const destinations = loadAll();

  if (isVertical) {
    const activeV = destinations.filter(isPlayableVertical);
    console.log(activeV.length === 0
      ? '[ingest] Señal VERTICAL conectada. Sin destinos verticales activos — actívalos en el panel.'
      : `[ingest] Señal VERTICAL conectada. Auto-iniciando ${activeV.length} destino(s).`);
    setTimeout(() => onPublishVertical(sourceUrl, destinations), 1500);
    return;
  }

  const active = destinations.filter(isPlayable);
  if (active.length === 0) {
    console.warn('[ingest] Señal Conectada. Sin destinos activos — actívalos en el panel para iniciar el reenvío.');
  } else {
    console.log(`[ingest] Señal Conectada. Auto-iniciando ${active.length} destino(s).`);
  }
  // Siempre llama onPublish para que isLive() sea true y applyChange funcione
  // aunque el usuario encienda destinos DESPUÉS de que OBS ya esté conectado.
  setTimeout(() => onPublish(sourceUrl, destinations), 1500);
});

nms.on('donePublish', (id, StreamPath) => {
  const key = StreamPath.split('/').pop();
  if (key === `${loadSettings().streamKey}${VERTICAL_SUFFIX}`) {
    console.log('[ingest] Señal VERTICAL desconectada. Deteniendo reenvios verticales.');
    onUnpublishVertical();
    return;
  }
  console.log('[ingest] Señal Desconectada. Deteniendo reenvios.');
  onUnpublish();
});

nms.run();
startPanel(PANEL_PORT, {
  rtmpUrl: `rtmp://localhost:${RTMP_PORT}/live`,
  lanRtmpUrl: LAN_IP ? `rtmp://${LAN_IP}:${RTMP_PORT}/live` : null,
  lanIp: LAN_IP,
  rtmpPort: RTMP_PORT,
  streamKey: STREAM_KEY,
  httpPort: HTTP_PORT, // panel.js arma flvUrl con la clave ACTUAL (puede cambiar sin reiniciar)
  version,
});
initChatCommands(); // !clip desde el chat — ver src/chatcommands.js

console.log('============================================');
console.log(' Muxlyve — motor de retransmision');
console.log('============================================');
console.log(` Ingest RTMP:  rtmp://localhost:${RTMP_PORT}/live`);
// CN-027: antes imprimía STREAM_KEY completa — en el Docker/headless que este proyecto
// soporta, "docker logs" suele capturarse/reenviarse a un agregador remoto, y esta clave
// es la única protección del ingest RTMP (ver hallazgo CN-004 del reporte de seguridad).
// Enmascarada acá igual que ya hace la UI del panel del lado del cliente.
console.log(` Clave:    ${STREAM_KEY.slice(0, 3)}${'•'.repeat(Math.max(STREAM_KEY.length - 3, 4))}`);
console.log(` API HTTP:     http://localhost:${HTTP_PORT}`);
console.log(' Edita destinos en el panel web.');
console.log('============================================');

process.on('SIGINT', () => { onUnpublish(); process.exit(0); });
process.on('SIGTERM', () => { onUnpublish(); process.exit(0); });
