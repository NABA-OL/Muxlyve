# Versión exacta en vez de :20-slim flotante (CN-023) — pin de digest sha256 pendiente,
# requiere `docker pull node:20.18.1-slim && docker inspect --format='{{index .RepoDigests 0}}' node:20.18.1-slim`
# con el daemon de Docker corriendo (no disponible al momento de este fix).
FROM node:20.18.1-slim

# FFmpeg es necesario para el reenvio. --no-install-recommends (Trivy DS-0029): sin esto
# apt trae paquetes "sugeridos" que no hacen falta acá, agrandando la superficie de la
# imagen sin motivo.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

# Usuario no-root (CN-005) — sin esto, el proceso y cada hijo de FFmpeg corren como root
# dentro del contenedor.
RUN groupadd -r muxlyve && useradd -r -g muxlyve -d /app muxlyve \
    && chown -R muxlyve:muxlyve /app
USER muxlyve

# Puertos actuales de la app (CN-010) — 1935/8000 eran del esquema original, .env.example
# ya usa 19350 (RTMP)/19000 (HTTP interno)/19080 (panel).
EXPOSE 19350 19000 19080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PANEL_PORT||19080)+'/api/state',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Exec directo a node en vez de "npm start" (CN-008) — así el proceso Node (dueño de los
# handlers SIGINT/SIGTERM que paran limpio los hijos de FFmpeg, ver src/index.js) es PID 1,
# no el wrapper de npm, que no reenvía señales de forma confiable ni reapea huérfanos.
CMD ["node", "--env-file-if-exists=.env", "src/index.js"]
