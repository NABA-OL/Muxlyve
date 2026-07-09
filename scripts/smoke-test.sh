#!/usr/bin/env bash
# Desarrollado por BlacKraken Solutions (NABA-OL)
# Test de humo end-to-end: ingest -> relay -> sink RTMP local.
# SEGURO: respalda config/destinations.json y lo restaura SIEMPRE al salir
# (trap EXIT), pase lo que pase. Nunca lo sobrescribe con la plantilla.
set -u
cd "$(dirname "$0")/.."

CONFIG=config/destinations.json
BACKUP="$(mktemp)"
SINK=""; APP=""

cleanup() {
  [ -n "$APP" ] && kill "$APP" 2>/dev/null
  [ -n "$SINK" ] && kill "$SINK" 2>/dev/null
  # restaura tu config REAL desde el respaldo (no desde el example)
  [ -f "$BACKUP" ] && cp "$BACKUP" "$CONFIG" && rm -f "$BACKUP"
  wait 2>/dev/null
  echo "[smoke] config restaurada, procesos detenidos"
}
trap cleanup EXIT

[ -f "$CONFIG" ] && cp "$CONFIG" "$BACKUP" || { echo "no hay $CONFIG"; exit 1; }

# sink RTMP local en :1936 (destino real de prueba)
node --input-type=module -e "
import NMS from 'node-media-server';
const n=new NMS({rtmp:{port:1936,chunk_size:60000,gop_cache:true,ping:30,ping_timeout:60},http:{port:8001,allow_origin:'*'}});
n.on('postPublish',(id,sp)=>console.log('[SINK] recibio publish:',sp));
n.run();
" >/tmp/smoke_sink.log 2>&1 &
SINK=$!

npm start >/tmp/smoke_app.log 2>&1 &
APP=$!
sleep 2.5

curl -s -X POST http://localhost:8080/api/destinations -H 'Content-Type: application/json' \
  -d '{"name":"SmokeSink","url":"rtmp://127.0.0.1:1936/live/sink","enabled":true}' >/dev/null

ffmpeg -hide_banner -loglevel error -re -f lavfi -i testsrc=size=640x360:rate=30 \
  -f lavfi -i sine=frequency=1000 -c:v libx264 -preset ultrafast -tune zerolatency \
  -c:a aac -t 6 -f flv rtmp://localhost:1935/live/mistream >/tmp/smoke_pub.log 2>&1 &
PUB=$!
sleep 4

STATE=$(curl -s http://localhost:8080/api/state)
RELAYING=$(node -e "const d=JSON.parse(process.argv[1]);const s=d.destinations.find(x=>x.name==='SmokeSink');console.log(d.live&&s&&s.relaying)" "$STATE")
wait $PUB 2>/dev/null
sleep 1

SINK_OK=$(grep -c "SINK" /tmp/smoke_sink.log)

echo "----------------------------------------"
echo "relay activo durante emision : $RELAYING"
echo "paquetes llegaron al sink    : $([ "$SINK_OK" -gt 0 ] && echo si || echo no)"
echo "----------------------------------------"

if [ "$RELAYING" = "true" ] && [ "$SINK_OK" -gt 0 ]; then
  echo "[smoke] PASS"; exit 0
else
  echo "[smoke] FAIL — revisa /tmp/smoke_app.log"; exit 1
fi
