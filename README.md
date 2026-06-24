# Multi_Stream

App propia de **retransmisión (restreaming)**: recibe una sola señal desde OBS y la reenvía a Twitch, Kick, YouTube y TikTok Live a la vez — **sin marca de agua**, corriendo en tu máquina.

El reenvío se hace con FFmpeg en modo copia (`-c copy`), sin recodificar: carga mínima de CPU. El límite real es tu **velocidad de subida** (cada destino consume tu bitrate completo).

## Estructura

```
Multi_Stream/
├── src/index.js                      # Motor: ingest RTMP + reenvío FFmpeg
├── config/
│   ├── destinations.example.json     # Plantilla de destinos
│   └── destinations.json             # TUS claves (créalo, no se sube a git)
├── .env.example                      # Variables de entorno (copia a .env)
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Requisitos

- **Node.js 20+** y **FFmpeg** instalados (o usa Docker, que ya los incluye).
- OBS Studio.

## Puesta en marcha (sin Docker)

```bash
# 1. Instalar dependencias
npm install

# 2. Crear tu config a partir de los ejemplos
cp .env.example .env
cp config/destinations.example.json config/destinations.json

# 3. Edita config/destinations.json y pon tus claves reales de cada plataforma
#    (pon "enabled": true en las que quieras usar)

# 4. Arrancar el motor
npm start
```

## Puesta en marcha (con Docker)

```bash
cp .env.example .env
cp config/destinations.example.json config/destinations.json
# edita config/destinations.json con tus claves
docker compose up --build
```

## Cifrado de claves (opcional, recomendado)

Define `MASTER_KEY` en tu `.env` para cifrar las claves de stream en reposo (AES-256-GCM):

```bash
# genera una clave fuerte
openssl rand -base64 32
# pégala en .env -> MASTER_KEY=...
```

Con `MASTER_KEY` definida, `config/destinations.json` guarda las claves como `urlEnc` (cifradas), nunca en texto plano. Tras definirla, guarda cualquier destino en el panel para migrar las claves existentes. Sin `MASTER_KEY` el motor sigue funcionando pero guarda en texto plano (con aviso).

## Configurar OBS

En OBS → Ajustes → Emisión:
- **Servicio:** Personalizado
- **Servidor:** `rtmp://localhost:1935/live`
- **Clave de retransmisión:** `mistream` (el valor de `STREAM_KEY` en tu `.env`)

Dale a **Iniciar transmisión**. El motor detecta la conexión y reenvía automáticamente a los destinos activos.

## Claves de cada plataforma

| Plataforma | Dónde sacar la clave | Notas |
|---|---|---|
| Twitch | Creator Dashboard → Configuración → Stream | Clave fija |
| Kick | Dashboard → Stream | Servidor `rtmps://ingest.kick.com/live` |
| YouTube | Studio → Crear → En directo | Crea el evento primero |
| TikTok | Requiere clave RTMP (Creator Network / +1000 seguidores) | **Expira cada ~2h**, pégala cada sesión y pon `enabled: true` |

## Estado actual

✅ Fase 1 (MVP): ingest + reenvío multiplataforma desde archivo de config.

### Próximos pasos (Fase 2)
- Panel web para gestionar destinos sin editar JSON.
- Botón ON/OFF por plataforma en caliente.
- Campo rápido para la clave temporal de TikTok.
- Indicadores de estado y reconexión automática.

Ver `PLAN_MultiStream.md` para el roadmap completo.
