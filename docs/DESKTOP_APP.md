# Multi_Stream — Plan: convertir en app de escritorio instalable

Pivote de producto: en lugar de algo que el usuario abre en el navegador (`localhost`), una **aplicación instalable** (Windows primero, Mac después) que se abre como cualquier programa, funciona **offline** para transmitir, guarda las credenciales **cifradas en la máquina del usuario**, se **auto-actualiza** y se desbloquea con una **licencia de pago único**.

## Lo mejor: no se tira nada de lo hecho

La app actual ya es un **motor Node + un panel web local**. Una app Electron es exactamente eso por dentro: un proceso Node con una ventana que muestra una interfaz. Migrar = **envolver** el motor y el panel actuales en una ventana de escritorio. El usuario nunca ve `localhost` ni sabe que hay un servidor local.

```
                 App de escritorio (Electron)
   ┌──────────────────────────────────────────────┐
   │  Ventana (UI)  ←──  el panel actual (panel.js)│
   │      │                                        │
   │  Proceso principal (Node)                     │
   │      ├─ node-media-server  (ingest, ya hecho) │
   │      ├─ relays.js          (FFmpeg, ya hecho) │
   │      ├─ FFmpeg EMPAQUETADO  (binario incluido)│
   │      └─ licencia + auto-update (nuevo)         │
   └──────────────────────────────────────────────┘
        OBS  ──►  127.0.0.1:1935  (igual que hoy)
```

---

## 1. Framework: Electron (recomendado)

- **Electron** integra Node sin fricción → tu motor (node-media-server, FFmpeg, relays) corre tal cual. Empaqueta Windows hoy y Mac después con el mismo código.
- **Tauri** (alternativa más liviana) obligaría a reescribir el núcleo o a complicarse con sidecars Rust. **No conviene** dado que el motor ya es Node.
- Herramienta de empaquetado: **electron-builder** (genera instaladores `.exe`/NSIS para Windows, `.dmg` para Mac, y soporta auto-update y firma).

### Estructura propuesta
```
Multi_Stream/
├── electron/
│   ├── main.js          # Proceso principal: arranca motor + crea ventana
│   ├── preload.js       # Puente seguro UI <-> Node
│   ├── license.js       # Activación/validación de licencia
│   └── updater.js       # Auto-actualización
├── src/                 # Motor actual (sin cambios grandes)
├── resources/
│   └── ffmpeg/          # Binarios de FFmpeg por plataforma (empaquetados)
└── build/               # Iconos, certificados, config de electron-builder
```

---

## 2. FFmpeg empaquetado (crítico)

Hoy FFmpeg debe estar instalado en el sistema. En una app instalable **el usuario no debe instalar nada**. Solución:

- Incluir el **binario de FFmpeg** dentro de la app (`resources/ffmpeg/`), uno por plataforma (Windows `.exe`, Mac universal).
- En `relays.js`, en vez de invocar `ffmpeg` del PATH, usar la ruta al binario empaquetado (paquete `ffmpeg-static` o copiar el binario manualmente y resolver la ruta con `process.resourcesPath`).
- Verificar al arranque que el binario existe y es ejecutable.

> Nota de tamaño/licencia: FFmpeg pesa ~70-100 MB y es LGPL/GPL. Usar una build LGPL para distribución comercial y acreditar la licencia en los "Acerca de".

---

## 3. Modelo de licencia: pago único + activación flexible

### Decisión tomada: licencia **flexible**
- Una **license key** por compra.
- Permite **1–2 equipos** por llave, con opción de **liberar/trasladar** equipo desde la app.
- Descarga del instalador **siempre libre**; lo que se valida es la **activación**, no la descarga (cumple "descárgala las veces que quieras").

### Realidad sobre la protección
Ninguna protección local es 100% incrackeable (Electron es JavaScript inspeccionable). La meta realista: **que sea más fácil pagar que crackear** para el usuario común. Medidas razonables, sin paranoia:
- Validar la llave **online al activar** (una vez), guardando un token firmado en la máquina.
- Revalidación periódica suave (ej. cada X días al abrir, con margen offline generoso para no molestar a quien transmite sin buena conexión).
- Atar la activación a un **machine ID** (huella del equipo) para el límite de 1–2 equipos.
- Ofuscar/minificar el código del cliente (sube el costo de crackear, no lo hace imposible).

### Modo desarrollador / dueño (la app desbloqueada para ti)
El dueño no debe necesitar comprar su propia app. Tres mecanismos, conviene tenerlos todos:
- **Builds de desarrollo** (`npm run dev`): la validación de licencia se omite siempre → pruebas sin fricción.
- **Variable de entorno** `MS_DEV_UNLOCK=1`: salta la validación aunque sea build de producción.
- **Llave de dueño**: una key tuya que el backend marca como `unlimited` (sin límite de equipos), para probar el build final empaquetado tal como lo recibe un cliente.

Implementación: la función que decide "¿está activada?" devuelve `true` directamente si está en dev o si `MS_DEV_UNLOCK` está presente, antes de consultar nada. Para distribución, esa puerta NO debe quedar activa en el instalador público.

### Tensión offline ↔ licencia
"Funciona offline" y "validar licencia" conviven bien: la app **transmite sin internet**; solo necesita conexión para **activar la primera vez** y para **buscar updates**. Como para hacer stream igual se necesita internet, no hay fricción real.

---

## 4. Cobro y validación de llaves

### Backend de validación: reutilizar tu Vercel + MongoDB ✅
No hace falta montar servidor nuevo. En tu proyecto existente de Vercel:
- Añadir rutas serverless: `POST /api/licenses/activate` y `POST /api/licenses/validate` (y `POST /api/licenses/release` para liberar equipo).
- Colección `licenses` en Mongo: `{ key, email, status, maxDevices, devices: [machineId], createdAt }`.
- La app de escritorio pega a esas rutas. Consultas pequeñas y esporádicas → Vercel + Mongo sobra.

### Pasarela de pago — elegir según mercado
| Opción | Cuándo conviene | Pros | Contras |
|---|---|---|---|
| **Lemon Squeezy / Paddle** (Merchant of Record) | Venta **internacional** de software | **Genera y valida llaves por ti** (API de licencias con activaciones por equipo = tu modelo flexible ya resuelto). Maneja **impuestos/IVA** global. Webhooks listos. | Comisión algo mayor; menos control fino |
| **Stripe** | Quieres **control total** | Estándar, flexible, conocido | Tú manejas llaves, impuestos y activación (más trabajo) |
| **Mercado Pago / Bold** | Mercado **Colombia/LatAm** | Local, ya tienes experiencia (Wolf Finances), pagos locales (PSE, etc.) | No pensados para licencias de software ni impuestos globales |

**DECISIÓN TOMADA: Freemius.** (Lemon Squeezy quedó descartado: tras su compra por Stripe ahora exige Stripe Managed Payments, y **Stripe no admite vendedores de Colombia**.)

Freemius está hecho específicamente para **vender software con licencias y activación por equipo**, soporta vendedores de **Colombia** (pagos vía PayPal/Payoneer/transferencia) y es Merchant of Record (maneja impuestos/IVA). Aporta:
- Generación y gestión de **license keys** con activaciones/desactivaciones por equipo (el modelo flexible de 1–2 equipos ya resuelto por ellos).
- **API REST de licencias** para validar la key desde la app de escritorio.
- **Checkout embebido** para la web y envío automático de la key por correo.
- Webhooks para registrar la venta en tu Mongo si quieres.

> **Payoneer**: crea una cuenta de Payoneer para recibir los pagos (puente entre Freemius y tu banco colombiano).

Implicación: con Freemius, el grueso del backend de licencias lo ponen ellos. Tu Vercel+Mongo queda como capa **opcional** (registro propio, analítica, gestión avanzada). Paddle/Gumroad quedan como alternativas si algún día se quiere cambiar.

> Flujo con Lemon Squeezy: compra → LS genera la llave y la envía por email → webhook avisa a tu Vercel (opcional, para tu registro) → el usuario pega la llave en la app → la app valida contra LS (o contra tu Vercel) → activada.

---

## 5. Auto-actualización

- **electron-updater** (de electron-builder): publicas una nueva versión y la app **avisa y se actualiza sola**. Justo lo que quieres.
- Hosting de las actualizaciones: GitHub Releases (gratis) o tu propio Vercel/almacenamiento.
- Mostrar en la app un "Buscar actualizaciones" y un changelog.

---

## 6. Firma de código (no opcional para producto serio)

Sin firma, Windows (SmartScreen) y Mac (Gatekeeper) marcan la app como "peligrosa" y asustan al usuario.
- **Windows:** certificado de firma de código (OV ~$70-200/año, o EV para evitar el aviso de SmartScreen desde el día 1).
- **Mac:** cuenta de Apple Developer ($99/año) + notarización.
- Se puede empezar **sin firma** para tus pruebas personales, pero antes de vender hay que firmar.

---

## 7. Fases

### Fase A — Empaquetar lo actual como app de escritorio (sin licencia)
- Integrar Electron: `main.js` arranca el motor actual y abre una ventana con el panel.
- Empaquetar FFmpeg dentro.
- Generar instalador `.exe` con electron-builder.
- **Resultado:** abres el instalador, se instala, lo abres y funciona igual que hoy pero como app nativa. Solo Windows.

### Fase B — Licencia y activación
- Rutas serverless en tu Vercel + colección Mongo.
- Pantalla de activación en la app (pegar llave → validar → guardar token).
- Machine ID + límite flexible de equipos + liberar equipo.
- Integrar la pasarela elegida.

### Fase C — Auto-update y firma
- electron-updater + publicación de versiones.
- Firma de código Windows.

### Fase C.5 — UI mejorada + grabador de clips ✅ HECHO
- **Layout 50/50**: preview + config OBS en la mitad izquierda (sticky al scroll), destinos en la mitad derecha.
- **Grabador de clips**: buffer rodante de últimos 30s/1min/2min disponible. Mientras OBS transmite, FFmpeg copia segmentos continuamente en `/tmp`. Al pulsar "Guardar clip", concatena los últimos N segmentos en MP4 sin recodificar (misma bitrate/codec que OBS).
- **Selector de carpeta**: usuario elige dónde guardar clips. En Electron, abre el selector nativo del SO; en modo servidor, permite escribir la ruta a mano. La carpeta se recuerda entre sesiones (`localStorage`).
- **Fix: edición de URLs** → el poll cada 2s ya no resetea los campos mientras escribes.
- **FFmpeg en Mac**: `resolveFfmpeg()` detecta Homebrew (`/opt/homebrew/bin/ffmpeg` o `/usr/local/bin/ffmpeg`) antes de usar `ffmpeg-static` (que tiene TLS limitado en macOS).

### Fase D — Mac
- Build para macOS, firma + notarización Apple.
- **FFmpeg bundleado**: descargar binario macOS de evermeet.cx, meterlo en `resources/ffmpeg`, declarar en electron-builder `extraResources`. El `.app` incluye ffmpeg — usuario no necesita Homebrew.

### Fase E — Pulido de producto 🔲 PENDIENTE
- **Splash screen con animación**: ventana custom al arrancar (spinner + logo + "Cargando…") mientras se inicia el motor. Cierra cuando esté listo.
- **Instalador custom NSIS** (Windows): script personalizado con logo branded, colores de marca, mensajes custom (en lugar del default de electron-builder).
- Onboarding, "Acerca de" con licencias de FFmpeg, pantalla de ajustes, manejo de errores amable.

---

## 8. Lo que NO cambia

- El motor (`node-media-server`, `relays.js`, `destinations.js`) sigue igual.
- El cifrado de credenciales en reposo (ya hecho) cobra aún más sentido aquí.
- OBS sigue apuntando a `rtmp://localhost:1935/live`.
- Toda la lógica de reenvío, reconexión y métricas de la Fase 3 se reutiliza.

---

## 9. Decisiones pendientes de confirmar

1. **Mercado inicial** (global vs Colombia) → define la pasarela.
2. **Pasarela final**: Lemon Squeezy vs Stripe vs Bold/Mercado Pago.
3. **Precio** del pago único.
4. ¿Empezar la Fase A **sin firma** (para tus pruebas) y firmar antes de vender? (recomendado).

---

## 10. Prompt sugerido para Code (Fase A)

> Quiero convertir Multi_Stream en una app de escritorio con Electron, reutilizando el motor actual (`src/`). Lee `docs/DESKTOP_APP.md`. Implementa la **Fase A**: integra Electron (`electron/main.js` que arranque el motor actual y abra una ventana cargando el panel), empaqueta el binario de FFmpeg dentro de la app y haz que `relays.js` use esa ruta en vez del FFmpeg del sistema, y configura electron-builder para generar un instalador `.exe` de Windows. No toques la lógica de reenvío. Aún sin licencia ni firma — solo que se instale y funcione como app nativa.
