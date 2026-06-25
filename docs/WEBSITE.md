# Multi_Stream — Plan: página web (landing + tienda + licencias)

Segundo proyecto del producto: una **página web** que presenta la aplicación, permite **comprarla** y **descargarla**, y aloja el **backend de licencias** (emitir/validar llaves). Es un repo distinto al de la app.

## Las 3 piezas del producto (en 2 repos)

```
Repo 1: Multi_Stream (app)          Repo 2: multistream-web (web + licencias)
 - Electron + motor de stream         - Landing (qué hace, para qué)
 - Pantalla de activar licencia        - Tienda / checkout
                                       - Descarga del instalador
                                       - /api/licenses/* (backend)
                                       - Base de datos (Mongo)
```

> El **backend de licencias NO es un tercer repo**: vive dentro del proyecto web (rutas serverless del mismo Vercel). Así son solo dos repos de GitHub.

## Flujo completo

```
1. Usuario entra a la web → ve qué hace, precio, requisitos.
2. Clic en "Comprar" → pasarela de pago.
3. Pago confirmado  → la PASARELA avisa al backend (webhook)
                     → el backend genera la KEY, la guarda en Mongo
                     → muestra la key en pantalla Y la envía por correo.
4. Usuario descarga el instalador (.exe) desde la web.
5. Instala, abre la app, pega la key.
6. La app valida la key contra /api/licenses/validate → activada.
7. Transmite offline; solo pidió internet para activar.
```

### Regla de oro de seguridad
La **generación de la key pasa SIEMPRE por el webhook de la pasarela** (server-to-server), nunca por el navegador. El frontend solo muestra el resultado. Si se generara en el cliente, cualquiera falsificaría llaves sin pagar.

---

## Stack recomendado para la web

- **Next.js** (en Vercel) — landing + tienda + rutas API en un solo proyecto. Es el encaje natural con lo que ya usas.
- **MongoDB** (la que ya tienes o una nueva gratuita en Atlas) — colección `licenses`.
- **Envío de correo:** **Resend** (el más simple con Vercel/Next). Alternativas: SendGrid, Mailgun.
- **Pasarela de pago: Freemius** (decisión tomada). Soporta Colombia, es Merchant of Record y está hecho para licencias de software. Lemon Squeezy quedó descartado por exigir Stripe (no disponible en Colombia).

> Con Freemius, gran parte del backend de licencias lo pone él (genera/valida llaves, activación por equipo, envía la key por correo, checkout embebido). La web sería sobre todo **landing + descarga + checkout de Freemius**, y el Mongo propio queda **opcional** (registro/analítica). Crea una cuenta de **Payoneer** para recibir pagos.

---

## Estructura de la colección `licenses` (Mongo)

```js
{
  key: "MS-XXXX-XXXX-XXXX",     // generada en el webhook
  email: "cliente@correo.com",
  status: "active",             // active | refunded | disabled
  maxDevices: 2,                 // licencia flexible
  devices: ["machineId1"],      // equipos activados
  order: "id-de-la-pasarela",   // para trazabilidad
  createdAt: Date
}
```

## Endpoints del backend

| Ruta | Qué hace |
|---|---|
| `POST /api/webhook/pago` | Recibe confirmación de la pasarela → crea la key → envía correo |
| `POST /api/licenses/activate` | La app activa la key en un equipo (respeta `maxDevices`) |
| `POST /api/licenses/validate` | La app revalida periódicamente |
| `POST /api/licenses/release` | Liberar un equipo (para trasladar la licencia) |

---

## Páginas de la web

1. **Inicio (landing):** qué es, para qué sirve, "sin marca de agua", plataformas soportadas (Twitch/Kick/YouTube/TikTok), capturas/demo, precio, botón comprar.
2. **Comprar / checkout:** pide correo → pasarela → confirmación con la key.
3. **Descargar:** instalador de Windows (y Mac a futuro), requisitos, versión actual.
4. **Gestionar licencia (opcional):** ver mis equipos, liberar uno, reenviar la key al correo.
5. **Legales:** términos, política de reembolso, créditos de FFmpeg (LGPL).

---

## Dónde se aloja el instalador (.exe)

- La app se compila en el repo `Multi_Stream` (electron-builder) → produce el `.exe`.
- Súbelo a **GitHub Releases** (gratis) y la web enlaza a esa descarga; o súbelo a tu almacenamiento. Ventaja de GitHub Releases: también lo usa el **auto-updater** de la app (un solo lugar para las versiones).

---

## Cómo se mantienen sincronizados los dos repos

- La **versión** de la app (ej. `1.2.0`) se publica en GitHub Releases del repo de la app.
- La web lee/enlaza esa última versión en la página de descarga.
- La app, al abrir, consulta GitHub Releases para auto-actualizarse.
- Resultado: publicas una versión nueva en el repo de la app → la web y el auto-updater la reflejan sin tocar el repo web.

---

## Fases de la web

### Fase 1 — Landing informativa
Solo presentación (qué hace, capturas, "próximamente"). Sirve para empezar a mostrar el producto sin tener pagos aún.

### Fase 2 — Descarga
Sección de descarga del instalador (incluso en beta gratuita para primeros usuarios).

### Fase 3 — Pagos + licencias
Integrar **Freemius** (checkout embebido + generación/validación de key + correo automático con la key). El Mongo propio queda opcional (registro/analítica vía webhook de Freemius).

### Fase 4 — Gestión de licencia
Página de autoservicio (ver equipos, liberar, reenviar key).

---

## Decisiones tomadas
- **Pasarela: Freemius** (Merchant of Record, soporta Colombia, hecho para licencias de software). Lemon Squeezy descartado por exigir Stripe (no disponible en Colombia).
- **Cobro: Payoneer** como método para recibir los pagos de Freemius.
- **Backend de licencias:** lo cubre Freemius; el Mongo propio es opcional.

## Decisiones aún pendientes
1. Precio del pago único.
2. Nombre/dominio de la web.

---

## Prompt sugerido para Code (nuevo repo, Fase 1)

> Crea un proyecto nuevo de Next.js para la web de Multi_Stream (landing del producto). Es un repo separado de la app. Por ahora solo la **landing informativa**: hero con el nombre y el claim "Multistreaming sin marca de agua a Twitch, Kick, YouTube y TikTok", sección de características, plataformas soportadas, capturas (placeholder), precio (placeholder) y un botón "Descargar" (placeholder). Usa la identidad visual de `docs/BRANDING.md` del repo de la app (paleta morado #7c5cff, fondo oscuro, logo). Prepáralo para desplegar en Vercel. Aún sin pagos ni backend.
