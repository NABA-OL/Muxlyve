---
name: Muxlyve
description: Panel de control local para restreaming multiplataforma sin marca de agua.
colors:
  bg: "#0d1117"
  surface: "#161b22"
  surface-2: "#1c2230"
  border: "#2a3140"
  text: "#e6edf3"
  muted: "#8b949e"
  accent: "#7c5cff"
  accent-2: "#2ea043"
  danger: "#f85149"
  live: "#2ea043"
  warn: "#f0a23a"
  off: "#484f58"
  accent-blue: "#4da3ff"
typography:
  display:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.1rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.03em"
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "ui-monospace, monospace"
    fontSize: "0.72rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.06em"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
spacing:
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.85rem"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
  button-toggle-on:
    backgroundColor: "{colors.accent-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.85rem"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "1.1rem 1.2rem"
---

# Design System: Muxlyve

## 1. Overview

**Creative North Star: "The Quiet Cockpit"**

Un centro de control denso pero respirando: superficies oscuras en capas, un único acento
púrpura de marca, y estado de conexión que se lee de lejos sin ruido. Es la cabina de un
streamer en vivo — todo lo crítico visible de inmediato, lo secundario plegado y fuera del
camino. Moderno, limpio, premium por acabado, no por ornamento.

Rechaza explícitamente lo de PRODUCT.md: el fondo cálido "crema" de SaaS genérico, el
hero-metric con gran número, las tarjetas idénticas repetidas, y la estética "gaming" neon
sobrecargada. No es una copia de Restream/OBS: el estado de relay en vivo (verde/ámbar/rojo)
es el protagonista, no el marketing.

**Key Characteristics:**
- Dark-first con tema claro opcional, ambos a WCAG AA.
- Un acento (púrpura `#7c5cff`); el verde `#2ea043` está reservado para "en vivo".
- Profundidad por capas tonales (`surface`/`surface-2`) + glow de estado, no por sombras pesadas.
- Micro-estados con `prefers-reduced-motion` respetado en cada animación.
- Tipografía sobria de sistema; mono solo para claves/IDs técnicos.

## 2. Colors: The Quiet Cockpit Palette

Paleta oscura en capas con un acento púrpura y un verde de "live" semántico. El púrpura es
marca; el verde/ámbar/rojo son lenguaje de estado, no decoración.

### Primary
- **Brand Violet** (`#7c5cff`): acento único de marca. Toggles activos, botones primarios,
  enlaces, glow del preview en vivo, bordes de destino TikTok. Usado con restraint.

### Secondary
- **Signal Green** (`#2ea043`): estado "en vivo"/relay saludable, toggle ON, píldora live.
  Es semántico, no un segundo acento decorativo.

### Neutral
- **Abyss** (`#0d1117`): fondo base (dark).
- **Deck** (`#161b22`): superficie de cards, header, modales.
- **Deck Raised** (`#1c2230`): superficie-2, campos, filas de chat, hover.
- **Hairline** (`#2a3140`): bordes y divisores.
- **Ink** (`#e6edf3`): texto principal.
- **Ash** (`#8b949e`): texto muted, etiquetas, placeholders (debe cumplir 4.5:1 sobre Deck).
- **Off** (`#484f58`): estados inactivos, toggles OFF, texto "pronto".

### State (semánticos, no son roles de marca)
- **Alarm Red** (`#f85149`): fallo de relay, borde OFF de bloque, botones de peligro.
- **Amber** (`#f0a23a`): reconectando / rezagado.
- **Signal Blue** (`#4da3ff`): compañero del glow en vivo (morado→azul).

### Named Rules
**The One Accent Rule.** El púrpura `#7c5cff` se usa en ≤15% de cualquier pantalla; su
rareza lo hace legible como "marca". El verde/ámbar/rojo son lenguaje de estado, no competidores
del acento.

**The Status-Is-Content Rule.** Verde/ámbar/rojo never decoran; solo comunican estado de relay.
Si un elemento no reporta estado de conexión, no usa esos colores.

## 3. Typography

**Display Font:** system-ui, -apple-system, "Segoe UI", sans-serif (con fallback de sistema).
**Body Font:** misma pila de sistema.
**Label/Mono Font:** ui-monospace, monospace (reservado para claves RTMP, IDs, stats técnicas).

**Character:** Sobrio y neutral. La jerarquía nace de peso y tamaño, no de contraste de familias.
El mono aporta el tono "herramienta técnica" solo donde hay datos de máquina.

### Hierarchy
- **Wordmark** (700, 1.1rem, -0.03em): logo "Muxlyve" en el header, "ve" en púrpura.
- **Body** (400, 0.85rem, 1.5): texto general, descripciones, notas.
- **Label** (600, 0.72rem, mono, 0.06em, uppercase): encabezados de sección ("CONEXIÓN",
  "CUENTAS"), stats de ingest.
- **Technical** (mono, 0.8rem): claves de stream, URLs, IDs de usuario en chat.

### Named Rules
**The Mono-For-Machines Rule.** Solo datos de máquina (claves, URLs, IDs, bitrate/fps) usan
mono. Prosa y etiquetas de UI usan la pila de sistema.

## 4. Elevation

Profundidad por capas tonales y glow de estado, no por sombras pesadas. Superficies planas a
reposo; el glow (`box-shadow` + `inset` con `color-mix` del acento o del color de estado)
aparece solo como respuesta a estado (preview en vivo, bloque de plataforma ON/OFF). Sombras
duras (`0 24px 64px rgba(0,0,0,.5)`) solo en modales, que flotan sobre el cockpit.

### Shadow Vocabulary
- **Modal Lift** (`box-shadow: 0 24px 64px rgba(0,0,0,.5)`): modales de preferencias/licencia.
- **Dropdown** (`0 12px 28px rgba(0,0,0,.35)`): menús del chat (`.chat-menu-dd`).
- **State Glow** (`0 8px 25px -8px color-mix(in srgb, var(--glow) 55%, transparent), inset 0 0
  16px -8px ...`): preview y bloques de plataforma, tinteado por estado.
- **Field Rest** (`0 1px 2px rgba(0,0,0,.15)`): campos de conexión, apenas perceptible.

### Named Rules
**The Flat-By-Default Rule.** Superficies planas a reposo. Glow/sombra aparecen solo por estado
o por modal; nunca decoran una card vacía.

## 5. Components

### Buttons
- **Shape:** radius 8px (md).
- **Primary:** fondo púrpura `#7c5cff`, texto blanco, padding `0.5rem 0.85rem`, weight 600.
  Hover: `filter: brightness(1.1)`. Active: `translateY(1px)`.
- **Toggle ON:** fondo verde `#2ea043`, texto Ink.
- **Ghost/Danger:** transparente con borde; danger usa borde/texto rojo `#f85149`, hover
  `rgba(248,81,73,.1)`.

### Chips / Pills
- **Style:** radius 999px, fondo `surface-2`, texto muted.
- **State:** `live` → fondo `rgba(46,160,67,.15)` texto verde; `reconnecting`/`lagging` →
  ámbar; `failed` → rojo. Comunican estado de relay (ver The Status-Is-Content Rule).

### Cards / Containers
- **Corner Style:** 12px (xl).
- **Background:** `surface` (`#161b22`), borde `hairline`.
- **Shadow Strategy:** plano; glow solo en preview/bloques de plataforma por estado.
- **Internal Padding:** `1.1rem 1.2rem` (cards), `1rem 1.2rem` (add-card).
- **Platform block** (`.pb-block`): borde 12px, collapsable; glow morado (ON) o rojo (OFF) por
  estado. Sub-bloques anidados planos (sin su propia card) para evitar cajas dentro de cajas.

### Inputs / Fields
- **Style:** fondo `bg`, borde `hairline`, radius 8px, padding `0.5rem 0.65rem`, mono 0.88rem.
- **Focus:** `outline: none; border-color: accent` (púrpura). Sin glow ajeno.
- **Error/Disabled:** borde rojo en peligro; `off` para inactivos.

### Toggle Switch
- **Style:** 42×24px, track `off` (`#484f58`) → `accent` cuando checked; thumb blanco 18px
  que desliza 18px. Versión sistema 36×20px para filas de preferencias.

### Navigation / Header
- **Style:** sticky, `surface`, borde inferior `hairline`, alto 68px. Wordmark izquierda,
  acciones derecha. Drag-region en Electron; padding extra en Darwin/Win32 para no encimar
  botones de ventana.

### Signature Component: Connection Status Glow
El preview de video y los bloques de plataforma usan `--glow-video` / `--glow` animado vía
`@property`: offline = rojo↔naranja (ciclo corto, llama atención); en vivo = morado↔azul de
marca (ciclo 6s). Con `prefers-reduced-motion`, se congela en el color de estado. Es la firma
visual de "esto está transmitiendo".

## 6. Do's and Don'ts

### Do:
- **Do** usar el púrpura `#7c5cff` solo como acento de marca y el verde `#2ea043` solo para
  estado "en vivo" (The One Accent Rule).
- **Do** comunicar estado de relay con verde/ámbar/rojo en píldoras y glow de borde.
- **Do** respetar `prefers-reduced-motion` en cada animación (preview, pulse del dot, glow).
- **Do** usar mono (ui-monospace) exclusivamente para claves, URLs e IDs técnicos.
- **Do** mantener contraste 4.5:1: `Ash #8b949e` sobre `Deck #161b22` y `Ink #e6edf3` sobre
  `Abyss #0d1117` cumplen AA; verificá el tema claro también.

### Don't:
- **Don't** usar fondo cálido "crema" ni paleta near-white tipo SaaS genérico (anti-referencia
  de PRODUCT.md).
- **Don't** imitar el layout de Restream/OBS uno a uno; el estado de relay en vivo es el
  protagonista propio.
- **Don't** usar estética "gaming" neon sobrecargada (neones brillosos, sombras difusas
  saturadas).
- **Don't** meter glow decorativo en cards en reposo; el glow es respuesta a estado (The
  Flat-By-Default Rule).
- **Don't** anidar tarjetas dentro de tarjetas; los sub-bloques de plataforma son planos.
- **Don't** usar el verde/ámbar/rojo como decoración fuera de estado de conexión (The
  Status-Is-Content Rule).
