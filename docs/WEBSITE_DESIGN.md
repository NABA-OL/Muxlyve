# Multi_Stream — Diseño de la página web

Guía de diseño visual para la web (landing + descarga). Acompaña a `WEBSITE.md` (qué hace la web) — este doc define **cómo se ve y se siente**. La web debe sentirse claramente parte del mismo producto que la app de escritorio.

## Coherencia con la app (lo más importante)

La web reutiliza la identidad ya definida en `BRANDING.md` de la app:

- **Logo:** `src/public/logo.svg` (horizontal con wordmark) de la app.
- **Ícono:** `src/public/icon.svg` (cuadrado, para favicon y og:image).
- **Concepto de marca:** una fuente que se reparte en cuatro destinos.

> Acción para Code: **copiar** `logo.svg` e `icon.svg` desde el repo de la app a `public/` del repo web. Así son el mismo logo en los dos lados.

### Paleta (idéntica a la app)
| Rol | Color |
|---|---|
| Fondo | `#0d1117` |
| Superficie | `#161b22` |
| Borde | `#2a3140` |
| Texto | `#e6edf3` |
| Texto apagado | `#8b949e` |
| Acento (marca) | `#7c5cff` (morado) |
| Acento 2 | `#4da3ff` (azul) |
| Éxito | `#2ea043` |
| Degradado marca | `#7c5cff` → `#4da3ff` |

Colores de plataformas (para los íconos en hero/animación): Twitch `#9146FF`, Kick `#53FC18`, YouTube `#FF0000`, TikTok `#25F4EE`/`#FE2C55`.

### Tipografía
- Interfaz: `system-ui` (igual que la app) o una sans moderna como **Inter** si se quiere algo más de "producto" — ambas combinan. Pesos 400 y 600.
- Sentence case, nada de TODO MAYÚSCULAS.

### Tono visual
Oscuro, técnico pero limpio, espacioso. Mismo "look" del panel: tarjetas con borde sutil, esquinas redondeadas (12px), acentos morados. Que quien vea la web reconozca la app y viceversa.

---

## Estructura: una landing + descarga

Recomendación: **no muchas páginas**. Una landing principal con secciones ancladas + una página de descarga. El checkout lo aloja Freemius (externo).

### Navegación (barra superior)
`[logo] Multi_Stream      Inicio · Características · Precio · [ Descargar ]`
- El botón "Descargar" destacado en morado.
- Barra fija (sticky), fondo `#161b22` translúcido al hacer scroll.

### Secciones de la landing (scroll)
1. **Hero** — logo animado (ver abajo) + claim + botón "Descargar gratis" / "Comprar". Claim: *"Transmite a Twitch, Kick, YouTube y TikTok a la vez. Sin marca de agua. Desde tu PC."*
2. **Qué hace / problema** — el dolor (Restream cobra y pone marca de agua) → tu solución.
3. **Características** — tarjetas: sin marca de agua, corre en tu máquina, reconexión automática, preview en vivo, pago único.
4. **Plataformas** — los 4 logos (Twitch/Kick/YouTube/TikTok).
5. **Precios** — tres planes (mensual / anual / vitalicia — modelo híbrido, ver `PRICING.md`), con la **vitalicia destacada** como el diferenciador ("paga una vez vs mensualidad eterna de Restream"). Toggle mensual/anual como hace Restream. Botón de compra (Freemius).
6. **Descarga / requisitos** — enlace al instalador (Windows; Mac "próximamente").
7. **Footer** — legales, créditos FFmpeg (LGPL), contacto.

### Páginas aparte
- `/descargar` — instalador, versión actual, requisitos, instrucciones de OBS.
- `/gestionar-licencia` (opcional, futuro) — o usar el portal de Freemius.

---

## Animación de entrada (hero)

El logo ES el concepto de multistream. Animarlo cuenta la historia sin palabras.

### Concepto
Al cargar la página, en el hero:
1. Aparece el **nodo de origen** (punto morado, izquierda) con un leve pulso.
2. Las **cuatro líneas curvas** se "dibujan" saliendo del nodo (animar `stroke-dashoffset`), una tras otra con un pequeño retardo entre cada una.
3. Al llegar cada línea a su destino, **aparece el ícono de la plataforma** (Twitch, Kick, YouTube, TikTok) con un pop suave.
4. Queda un pulso sutil y continuo en las líneas (como "señal fluyendo") — opcional, discreto.

### Implementación sugerida
- **SVG animado con CSS** (`stroke-dasharray`/`stroke-dashoffset` + `@keyframes`) — ligero, sin librerías. Es lo más simple y elegante.
- Si se quiere algo más rico: **Framer Motion** (si la web es Next.js/React) o **GSAP**. Pero CSS puro basta y carga al instante.
- Respetar `prefers-reduced-motion`: si el usuario desactivó animaciones, mostrar el logo estático.
- Duración total ~1.5–2s, que no canse ni retrase la lectura del claim.

### Microinteracciones extra (opcionales)
- Botón "Descargar" con leve elevación al hover.
- Las tarjetas de características aparecen con fade-in al hacer scroll (intersection observer).
- Los 4 logos de plataforma con un brillo sutil al pasar el mouse.

---

## Stack de la web (recordatorio de WEBSITE.md)
- **Next.js** en Vercel.
- Animación: CSS/SVG (o Framer Motion si ya se usa React).
- Checkout: **Freemius** embebido.
- Imágenes/capturas del panel: usar el rediseño ya hecho como referencia visual.

---

## Prompt para Code (web, Fase 1 con diseño)

> Crea un proyecto Next.js para la web de Multi_Stream (repo separado). Lee `WEBSITE.md` y `WEBSITE_DESIGN.md`. Implementa la **landing** con la identidad visual de la app: copia `logo.svg` e `icon.svg` (te los paso) a `public/`, usa la paleta oscura (fondo `#0d1117`, acento morado `#7c5cff`, degradado a `#4da3ff`). 
>
> Estructura: una landing de una sola página con secciones ancladas (Hero, Qué hace, Características, Plataformas, Precio, Descarga, Footer) + barra de navegación sticky con botón "Descargar" destacado + una página `/descargar`.
>
> En el **hero**, implementa la **animación de entrada del logo**: el nodo de origen y las cuatro líneas curvas se dibujan con `stroke-dashoffset`, y los íconos de Twitch/Kick/YouTube/TikTok aparecen al final de cada línea. Usa SVG + CSS (respeta `prefers-reduced-motion`). Claim del hero: "Transmite a Twitch, Kick, YouTube y TikTok a la vez. Sin marca de agua. Desde tu PC."
>
> Aún sin pagos reales (botón de compra como placeholder hacia Freemius). Prepáralo para desplegar en Vercel.
