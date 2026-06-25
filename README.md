# Muxlyve

App de **multistreaming** propia: recibe una señal desde OBS y la reenvía en simultáneo a Twitch, Kick, YouTube y TikTok Live — **sin marca de agua**, corriendo en tu máquina.

El reenvío usa FFmpeg en modo copia (`-c copy`), sin recodificar: carga mínima de CPU. El límite real es tu **velocidad de subida** (cada destino consume tu bitrate completo).

---

## Comandos

### Desarrollo

```bash
npm run dev          # Motor headless con hot-reload (Node --watch)
npm run electron     # App de escritorio Electron (abre ventana con el panel)
```

### Producción (headless)

```bash
npm start            # Motor solo, sin UI — para Docker / servidor
```

### Builds e instaladores

```bash
# Windows — genera instalador .exe en dist-app/
npm run dist

# Windows — genera .exe Y lo publica en GitHub Releases
npm run dist:publish

# Mac — descarga FFmpeg + genera .dmg localmente (ejecutar en Mac)
npm run dist:mac

# Mac — publica .dmg en GitHub Releases (ejecutar después de dist:mac)
npm run dist:publish
```

> `dist:publish` auto-detecta plataforma: en Windows publica `.exe`, en Mac publica `.dmg`. Requiere `GH_TOKEN` en `.env`.

### Utilidades

```bash
npm run validate     # Valida config/destinations.json
npm test             # Smoke test — verifica que el motor arranca
```

---

## Requisitos

- **Node.js 20+** y **FFmpeg** instalados (o usa Docker).
- OBS Studio.
- Para el `.exe`: ejecutar en Windows (ffmpeg-static descarga el binario de la plataforma).
- Para el `.dmg`: ejecutar en Mac.

---

## Puesta en marcha (sin Docker)

```bash
# 1. Instalar dependencias
npm install

# 2. Crear config a partir de los ejemplos
cp .env.example .env
cp config/destinations.example.json config/destinations.json

# 3. Editar config/destinations.json con tus claves reales
#    (pon "enabled": true en las plataformas que quieras usar)

# 4. Arrancar la app de escritorio
npm run electron

# — o el motor headless —
npm start
```

## Puesta en marcha (Docker)

```bash
cp .env.example .env
cp config/destinations.example.json config/destinations.json
# edita config/destinations.json con tus claves
docker compose up --build
```

---

## Estructura

```
Muxlyve/
├── electron/
│   ├── main.js               # Proceso principal Electron
│   ├── splash.html           # Pantalla de carga
│   ├── activate.html         # Pantalla de activación de licencia
│   └── license.js            # Gestión de licencias
├── src/
│   ├── index.js              # Motor: ingest RTMP + reenvío FFmpeg
│   ├── destinations.js       # Carga/guarda/valida destinos
│   ├── relays.js             # Procesos FFmpeg por destino
│   └── panel.js              # Panel web (localhost)
├── config/
│   ├── destinations.example.json
│   └── destinations.json     # TUS claves (no se sube a git)
├── build/                    # Assets del instalador (íconos, NSIS)
├── .env.example
├── Dockerfile
└── docker-compose.yml
```

---

## Cifrado de claves (recomendado)

Define `MASTER_KEY` en `.env` para cifrar las claves de stream en reposo (AES-256-GCM):

```bash
# Genera una clave fuerte
openssl rand -base64 32
# Pégala en .env → MASTER_KEY=...
```

Con `MASTER_KEY` definida, `config/destinations.json` guarda las claves cifradas como `urlEnc`. Sin ella el motor funciona igual pero guarda en texto plano (con aviso). Tras definir la clave, guarda cualquier destino en el panel para migrar las claves existentes.

---

## Configurar OBS

En OBS → Ajustes → Emisión:

| Campo | Valor |
|---|---|
| Servicio | Personalizado |
| Servidor | `rtmp://localhost:1935/live` |
| Clave | valor de `STREAM_KEY` en `.env` (por defecto: `mistream`) |

Dale a **Iniciar transmisión** — el motor detecta la señal y reenvía a los destinos activos.

---

## Claves por plataforma

| Plataforma | Dónde sacar la clave | Notas |
|---|---|---|
| Twitch | Creator Dashboard → Configuración → Stream | Clave fija |
| Kick | Dashboard → Stream | Servidor `rtmps://ingest.kick.com/live` |
| YouTube | Studio → Crear → En directo | Crea el evento primero |
| TikTok | Requiere RTMP (Creator Network / +1000 seguidores) | **Expira cada ~2h** — pégala antes de salir en vivo |

---

## Panel web

Disponible en `http://localhost:8080` mientras el motor está activo:

- Toggle ON/OFF por plataforma en caliente
- Editar URLs y claves sin tocar JSON
- Estado por destino: verde (transmitiendo), ámbar (reconectando), rojo (error)
- Métricas en tiempo real: bitrate / fps / velocidad
- Preview del stream vía HTTP-FLV
