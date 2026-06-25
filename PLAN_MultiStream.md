# Multi_Stream — Plan de Proyecto

**Objetivo:** Construir tu propia aplicación de retransmisión (restreaming) que tome una sola señal desde OBS y la reenvíe simultáneamente a Twitch, Kick, TikTok Live y YouTube — **sin marca de agua, gratis, corriendo en tu máquina** — con arquitectura pensada para que en el futuro pueda convertirse en un producto (la "competencia de Restream").

**Decisiones tomadas:**
- Enfoque: app propia desde cero.
- Infraestructura: local por ahora; nube a futuro.
- Plataformas objetivo: Twitch, Kick, TikTok Live, YouTube.

---

## 1. Cómo funciona (el concepto técnico)

Restream y similares hacen algo conceptualmente simple: reciben **una** señal RTMP y la **copian tal cual** (sin recodificar) a varios destinos. La marca de agua que tenías era solo una restricción comercial de su plan gratuito, no algo técnicamente necesario.

El flujo de tu app será:

```
OBS  ──RTMP──►  [Tu App: servidor de ingest local]
                        │
                        ├──► Twitch   (rtmp://...)
                        ├──► Kick     (rtmps://ingest.kick.com/live)
                        ├──► YouTube  (rtmp://a.rtmp.youtube.com/live2)
                        └──► TikTok   (rtmp://... clave temporal)
```

Punto clave: el reenvío se hace **sin recodificar** (copia de paquetes). Esto significa que tu PC casi no sufre carga extra por cada plataforma añadida — el cuello de botella real es tu **ancho de banda de subida** (cada destino consume tu bitrate completo de subida).

> Ejemplo: si transmites a 6.000 kbps y mandas a 4 plataformas, necesitas ~24 Mbps de subida sostenidos. Esto es lo más importante a validar antes de nada.

---

## 2. Requisitos confirmados por plataforma

| Plataforma | Protocolo | Notas importantes |
|---|---|---|
| **Twitch** | RTMP estándar | Clave de stream fija desde el dashboard. La más sencilla. |
| **Kick** | RTMPS | Servidor `rtmps://ingest.kick.com/live` (o `rtmp://ingest.kick.com/live`). Clave fija. Soporta hasta 8.000 kbps. |
| **YouTube** | RTMP estándar | `rtmp://a.rtmp.youtube.com/live2`. Clave fija. Hay que crear el evento "En vivo". |
| **TikTok Live** | RTMP | **El más restrictivo.** La clave de stream **expira cada 2 horas** y se regenera por sesión. Requiere típicamente +1.000 seguidores y/o pertenecer a una Creator Network para desbloquear la clave RTMP. La app debe permitir **pegar/actualizar la clave manualmente cada sesión**. |

**Implicación de diseño:** TikTok no puede tener credencial "fija guardada". El panel debe tener un campo rápido para pegar la clave temporal justo antes de salir en vivo.

---

## 3. Stack tecnológico recomendado

Pensado para que funcione local hoy y migre a un VPS mañana sin reescribir.

**Núcleo de retransmisión (el motor):**
- **Node-Media-Server** (Node.js) o **nginx con módulo RTMP** como servidor de ingest que recibe la señal de OBS.
- **FFmpeg** para el fan-out a cada destino (modo copia `-c copy`, sin recodificar).

> Recomendación: **Node-Media-Server + FFmpeg**, porque te da control programático total desde JavaScript (arrancar/parar destinos en caliente, leer estado, manejar la clave temporal de TikTok) y es el mismo lenguaje que el panel.

**Panel de control (la app que tú ves):**
- Backend: **Node.js + Express** (o NestJS si quieres estructura más seria).
- Frontend: **React** (panel web local en `localhost`).
- Base de datos: **SQLite** al inicio (cero configuración) para guardar destinos y credenciales.

**Seguridad de credenciales:**
- Cifrado de claves de stream en reposo (no guardarlas en texto plano).
- Para producto futuro: variables de entorno + un servicio de secretos.

**Empaquetado a futuro:** todo dentro de **Docker** desde el inicio facilita pasar de tu PC a un VPS con un solo comando.

---

## 4. Roadmap por fases

### Fase 0 — Validación (1–2 días)
- Medir tu **velocidad de subida real** (test sostenido, no pico).
- Calcular cuántas plataformas soporta tu conexión a tu bitrate deseado.
- Probar el concepto a mano: instalar el plugin **obs-multi-rtmp** en OBS y transmitir a 2 plataformas a la vez. Esto confirma que la idea funciona **sin escribir código** y te da una línea base.

### Fase 1 — MVP funcional (1–2 semanas)
- Servidor de ingest local que recibe RTMP de OBS.
- Reenvío con FFmpeg a Twitch + Kick + YouTube (claves fijas en archivo de config).
- Sin interfaz todavía: configuración por archivo. Objetivo: **probar que retransmite sin marca de agua**.

### Fase 2 — Panel de control (2–3 semanas)
- Interfaz web en `localhost`: añadir/editar/borrar destinos.
- Botón ON/OFF por plataforma (activar/desactivar destinos en caliente).
- Campo especial para la **clave temporal de TikTok**.
- Indicadores de estado: conectado / transmitiendo / error por plataforma.
- Cifrado de credenciales guardadas.

### Fase 3 — Robustez (2–4 semanas)
- Reconexión automática si una plataforma cae.
- Logs y métricas (bitrate, caídas, tiempo en vivo).
- Manejo de errores claros ("clave de TikTok expirada", "Twitch rechazó la conexión").
- Empaquetado en Docker.

### Fase 4 — Camino a producto (futuro)
- Despliegue en VPS/nube (el ingest deja de usar tu subida; subes 1 sola vez al servidor y él hace el fan-out).
- Multiusuario, registro/login, planes.
- Dashboard de analíticas, chat unificado, escenas, grabación.
- Modelo de negocio (freemium sin marca de agua como diferenciador frente a Restream).

---

## 5. Riesgos y consideraciones

- **Ancho de banda de subida** es el límite #1 en modo local. Si tu subida es baja (<20 Mbps), considera mover el ingest a un VPS antes de lo planeado, o bajar bitrate.
- **TikTok** es frágil: claves temporales, requisitos de seguidores y términos de servicio que pueden cambiar. Diséñalo para ser flexible y manual.
- **Términos de servicio:** retransmitir tu propia señal a tus propias cuentas es legítimo. Si a futuro lo conviertes en producto para terceros, revisa los ToS de cada plataforma (algunos restringen restreaming comercial).
- **Estabilidad local:** si tu PC se reinicia o satura, se cae todo. Por eso la nube es el destino natural del proyecto.

---

## 6. Próximos pasos inmediatos

1. Hacer el test de subida y el cálculo de capacidad (Fase 0).
2. Probar `obs-multi-rtmp` con 2 plataformas para validar el concepto hoy mismo.
3. Decidir entre Node-Media-Server vs nginx-rtmp para el motor.
4. Montar el esqueleto del proyecto (estructura de carpetas + Docker + SQLite).

---

## 7. Funcionalidades inspiradas en Restream (backlog priorizado)

Observadas en Restream como referencia. Ordenadas por **valor / esfuerzo** — implementar de arriba a abajo.

### 7.1 Previsualización del stream en el panel — ✅ HECHO

- `node-media-server` **ya expone HTTP-FLV** en el puerto HTTP (`http://localhost:8000/live/<STREAM_KEY>.flv`).
- Preview = reproducir ese FLV en el panel con `flv.js` (una etiqueta `<video>` + la lib). Sin recodificar, sin coste extra.
- Mostrar también la URL de ingest (`rtmp://localhost:1935/live`) y la `STREAM_KEY` con botón "copiar" (como Restream).
- **Sin dependencias de plataforma.** Es lo primero a hacer.

### 7.2 Editar título del stream en todas las plataformas a la vez — 🟡 MEDIO
- **No va por RTMP.** Requiere API OAuth por plataforma (registrar app + guardar tokens cifrados):
  - Twitch: Helix `PATCH /channels`. Bien documentada.
  - YouTube: Data API `liveBroadcasts.update`. Cuota diaria.
  - Kick: API pública nueva/limitada — verificar disponibilidad.
  - TikTok: API muy restringida — probablemente no viable a corto plazo.
- Diseño: por destino, guardar `{plataforma, oauthToken, channelId}`. Un botón "Actualizar títulos" itera las plataformas con token válido.
- Depende de **cifrado de credenciales** (ya pendiente en Fase 2).

### 7.3 Chat unificado (multi-plataforma con icono por origen) — 🔴 DIFÍCIL / FRÁGIL
- Agregar y mostrar con icono por origen es lo fácil; los **conectores** son el problema:
  - Twitch: IRC (`tmi.js`) o EventSub — fácil, estable.
  - YouTube: Live Chat API (polling, consume cuota) — ok.
  - Kick: **sin API oficial de chat**; hoy se hace con websockets Pusher no oficiales — frágil, puede romperse.
  - TikTok: **sin API oficial**; libs no oficiales (p.ej. TikTok-Live-Connector) — frágil + riesgo de ToS.
- Recomendación: empezar solo con Twitch + YouTube (oficiales). Kick/TikTok como "best effort" opcional.
- Arquitectura: un proceso por conector → normalizar a `{plataforma, autor, mensaje, ts}` → WebSocket al panel → render con icono.

### Orden sugerido
1. 7.1 Preview + URL/key (rápido, alto valor visual).
2. Robustez Fase 3 (reconexión, estados de error) — más útil que features nuevas.
3. 7.2 Títulos (Twitch + YouTube primero).
4. 7.3 Chat (Twitch + YouTube; Kick/TikTok opcional).

---

---

## 8. App de Escritorio (Electron)

### Fase A — Empaquetado Windows ✅ HECHO
- Electron wrapper que arranca el motor (NMS + FFmpeg + panel).
- `electron-builder` genera instalador `.exe` (NSIS).
- Ícono propio (`build/icon.ico`), sin barra de menú, ventana mínima 900×600.
- `ffmpeg-static` desempaquetado del `.asar` para que Windows lo ejecute.

### Fase B — Licencias online ✅ HECHO
- `electron/license.js`: machine ID (UUID persistente en `userData`), cifrado con `safeStorage` (DPAPI Windows).
- Flujo: activar clave → `POST /api/licenses/activate` → token firmado en disco.
- Grace period 30 días offline + 7 días extra sin red.
- `electron/activate.html` + `electron/preload.cjs`: pantalla de activación antes de abrir el panel.
- Bypass dev: `!app.isPackaged` (siempre) o `MS_DEV_UNLOCK=1` (var de entorno).

### Fase C — Actualizaciones automáticas + firma de código 🔲 PENDIENTE
- `electron-updater` + servidor de releases (GitHub Releases o Vercel).
- Certificado de firma de código EV (Windows): elimina el aviso "SmartScreen desconoce este editor".
- Sin firma: el `.exe` funciona pero Windows muestra alerta en primera ejecución.

### Fase D — macOS 🔲 PENDIENTE (futuro)
- `electron-builder` target `dmg` + `mas`.
- Requiere cuenta Apple Developer ($99/año) + notarización.

---

## 9. Seguridad pendiente — App de Escritorio

### 🔲 Obfuscar o reemplazar `MS_DEV_UNLOCK`
**Problema:** la variable de entorno `MS_DEV_UNLOCK=1` que permite saltarse el sistema de licencias está en texto plano dentro del `.asar`. Cualquiera que descomprima el instalador con `asar extract` puede leer el nombre de la variable y usarla para desactivar la protección.

**Impacto:** bajo hoy (producto no publicado). Alto cuando haya usuarios reales pagando.

**Solución propuesta (Fase C o antes de lanzamiento público):**
- Reemplazar la comprobación de string simple por una comprobación de HMAC o hash:
  ```js
  // En lugar de:
  if (process.env.MS_DEV_UNLOCK === '1') ...
  // Usar algo como:
  const OWNER_HASH = '...sha256 de un secret que solo tú conoces...';
  if (sha256(process.env.MS_OWNER_TOKEN) === OWNER_HASH) ...
  ```
- O usar `electron-builder`'s `asar` encryption (requiere pago).
- O simplemente activar la app con una licencia real propia (elimina necesidad del bypass).

**Alternativa más simple:** activar con tu propia clave de licencia real y eliminar el bypass completamente del código de producción.

---

*Documento de planificación — proyecto Multi_Stream. Puedo desarrollar cualquier sección en detalle (arquitectura del código, configuración de FFmpeg, estructura del repo, o empezar el MVP).*
