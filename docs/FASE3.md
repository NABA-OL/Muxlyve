# Multi_Stream — Plan de Fase 3 (Robustez, métricas y seguridad)

Estado al iniciar la Fase 3: el MVP (Fase 1) y casi toda la Fase 2 están hechos — ingest, reenvío en caliente, panel web con preview, toggle ON/OFF y campo de clave temporal de TikTok. Esta fase convierte el proyecto en algo **fiable para salir en vivo de verdad** y prepara el terreno para el producto.

Orden recomendado: 1 → 2 → 3 → 4 (de mayor a menor impacto).

---

## 1. Reconexión automática de relays  ⭐ (lo más crítico)

### Problema actual
En `relays.js`, cuando un proceso FFmpeg termina (la plataforma rechaza, se cae la red, expira la clave), el `close` solo hace `relays.delete(name)`. El destino queda muerto y **no vuelve solo**: pierdes esa plataforma en mitad del directo sin enterarte.

### Comportamiento deseado
Si un relay muere **mientras OBS sigue publicando** y el destino sigue habilitado, reintentar con **backoff exponencial** y un tope de intentos. Reflejar el estado (`reconnecting`, `failed`) en el panel.

### Diseño (sobre el código actual)
Cambiar el `Map` de `name -> ChildProcess` por `name -> { proc, status, attempts, timer }`. Estados: `connecting | live | reconnecting | failed | stopped`.

Lógica en el handler `close` de cada relay:

```js
// Pseudocódigo para relays.js
const MAX_ATTEMPTS = 6;
const BASE_DELAY = 2000; // ms

function onRelayClose(dest, code) {
  const r = relays.get(dest.name);
  if (!r || r.stopping) { relays.delete(dest.name); return; } // parada intencional
  if (!isLive() || !isPlayable(dest)) { relays.delete(dest.name); return; }

  if (r.attempts >= MAX_ATTEMPTS) {
    r.status = 'failed';
    console.error(`[relay:${dest.name}] agotados ${MAX_ATTEMPTS} intentos. Marcado como failed.`);
    return; // queda en el Map como 'failed' para que el panel lo muestre
  }
  const delay = Math.min(BASE_DELAY * 2 ** r.attempts, 30000); // tope 30s
  r.status = 'reconnecting';
  r.attempts += 1;
  console.warn(`[relay:${dest.name}] caído (code ${code}). Reintento ${r.attempts}/${MAX_ATTEMPTS} en ${delay}ms`);
  r.timer = setTimeout(() => startRelay(dest), delay);
}
```

Reglas:
- **Reset de `attempts` a 0** cuando un relay lleva > N segundos vivo y estable (p. ej. 15s sin morir) → así una caída puntual no consume el presupuesto de reintentos.
- En `stopRelay` marcar `r.stopping = true` y `clearTimeout(r.timer)` antes de matar, para distinguir parada manual de caída.
- Botón "Reintentar" en el panel para destinos en `failed` (resetea `attempts` y vuelve a arrancar).

### Cambios en la API/panel
- `buildState()` en `panel.js` ya expone `relaying`. Añadir `status` y `attempts` por destino.
- El panel pinta: `live` (verde), `reconnecting` (ámbar, "⟳ reconectando… intento N"), `failed` (rojo, con botón Reintentar).

### Criterio de aceptación
Matar a mano un relay (o cortar la red a una plataforma) → el panel muestra "reconectando" y el relay vuelve solo sin tocar OBS ni los demás destinos.

---

## 2. Estado real por plataforma + métricas

### Problema
Hoy "reenviando" solo significa que FFmpeg arrancó, no que la plataforma esté recibiendo bien. FFmpeg en stderr emite líneas de progreso (`frame=`, `bitrate=`, `speed=`) que sí reflejan salud real.

### Diseño
- Parsear el stderr de FFmpeg con `-progress pipe:` o leyendo las líneas `frame=… fps=… bitrate=… speed=…`.
- Por destino guardar: `bitrate`, `fps`, `speed`, `lastUpdate`. Si `speed < 0.9x` sostenido o `lastUpdate` viejo → alerta de "rezagado".
- Exponer en `/api/state` y mostrar en cada tarjeta (como en el mockup: "● reenviando · 6000 kbps").
- Tiempo en vivo (uptime) del directo en el header.

### Criterio de aceptación
El panel muestra bitrate/fps reales por plataforma y avisa si una se queda atrás.

---

## 3. Seguridad de las claves (cifrado en reposo)

### Problema
`config/destinations.json` guarda las claves de stream en **texto plano**. Para uso personal es tolerable (está en `.gitignore`), pero para "proyecto serio" y futuro multiusuario no.

### Diseño (local, sin sobre-ingeniería)
- Clave maestra desde `.env` (`MASTER_KEY`) o derivada con `scrypt` de una passphrase.
- Cifrar solo el campo sensible (la parte de la clave en la URL) con `crypto.createCipheriv` (AES-256-GCM). Guardar `{iv, tag, data}`.
- Descifrar en memoria al cargar; nunca loguear claves completas (ya hay `maskUrl`, mantenerlo).
- Para Fase 4 (nube/multiusuario): migrar a un gestor de secretos real (Vault, AWS Secrets Manager, etc.).

### Criterio de aceptación
El JSON en disco no contiene claves legibles; el panel sigue funcionando igual.

---

## 4. Calidad y empaquetado

- **Reconexión del preview**: si el preview flv.js se corta, reintentar al detectar `live` de nuevo (hoy se destruye y recrea — verificar que no quede pegado).
- **Logs a archivo** rotados (`media/logs/`) además de consola, para diagnosticar directos pasados.
- **Healthcheck** en el `docker-compose.yml` (endpoint `/api/health`).
- **Tests de humo** (ya hay `scripts/smoke-test.sh`): ampliar para cubrir reconexión.
- Revisar el `.env.example` y el README cuando se añadan `MASTER_KEY` y nuevas variables.

---

## Resumen de archivos a tocar

| Archivo | Cambio |
|---|---|
| `src/relays.js` | Reconexión con backoff, estados, reset de intentos, parseo de métricas |
| `src/panel.js` | Exponer `status`/`attempts`/métricas; UI de reconectando/failed/Reintentar; integrar logo |
| `src/destinations.js` | Cifrado/descifrado de claves |
| `.env.example` | `MASTER_KEY` |
| `docker-compose.yml` | healthcheck |
| `scripts/smoke-test.sh` | caso de reconexión |

---

## Prompt sugerido para Code

> Implementa la Fase 3 del proyecto Multi_Stream según `docs/FASE3.md`. Empieza por la sección 1 (reconexión automática de relays con backoff exponencial y estados) porque es la más crítica para uso en vivo. Mantén el estilo del código actual (ESM, sin dependencias nuevas salvo que sea imprescindible). Usa el logo en `src/public/logo.svg` / `icon.svg` al integrar la UI. Añade los estados al `/api/state` y píntalos en el panel.
