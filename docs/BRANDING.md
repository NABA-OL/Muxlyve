# Muxlyve — Identidad visual

Guía de marca para mantener coherencia en la app, la web y los documentos.

## Nombre de marca

**Muxlyve** — unión de **Muxly** + **Live**. (Antes "Multi_Stream", que era nombre de trabajo.)
- Escritura: `Muxlyve`, con la sílaba final **"ve"** en color de acento morado: Muxly + `ve`.
- Pronunciación/idea: "Muxly Live".

## Concepto del logo

Isotipo: una **cabeza de lobo esquemática vista de frente**, formada por un **nodo/señal central** (un triángulo de *play* = la transmisión en vivo, el hocico) del que salen **rayos hacia afuera** en forma de estrella/brújula. Doble lectura: la **señal que se divide y cubre todas las direcciones**, y la **manada** del lobo. Las orejas y la cara son triángulos geométricos. Ojos en espacio negativo, mirada al frente.

Archivos (finales, refinados en Inkscape):
- `src/public/logo-muxlyve.svg` — logo horizontal con wordmark, **para fondos oscuros** (texto claro `#e6edf3`).
- `src/public/logo-muxlyve-light.svg` — misma marca, **para fondos claros** (texto oscuro).
- `src/public/icon-muxlyve.svg` — isotipo cuadrado (favicon, app icon, redes). Funciona sobre cualquier fondo.

> Regla de uso: en superficies oscuras (la app, el panel) → `logo-muxlyve.svg`. En superficies claras (secciones blancas de la web, documentos impresos) → `logo-muxlyve-light.svg`. El icono es único.
> Los archivos viejos `logo.svg` / `icon.svg` (concepto fuente→4 destinos) quedan obsoletos.

## Animación del wordmark (web, top bar)

En la barra superior, el wordmark **Muxlyve** se **expande aleatoriamente** a **Muxly Live** (revela la sílaba "Li" oculta entre "Muxly" y "ve") y vuelve a contraerse, cada cierto intervalo aleatorio (~1.5–4s). Refuerza el significado del nombre. Implementar con transición CSS de ancho/opacidad; respetar `prefers-reduced-motion`.

## Paleta

| Rol | Color | Uso |
|---|---|---|
| Fondo | `#0d1117` | Fondo principal (oscuro) |
| Superficie | `#161b22` | Tarjetas, cabecera |
| Superficie 2 | `#1c2230` | Inputs, chips |
| Borde | `#2a3140` | Separadores |
| Texto | `#e6edf3` | Texto principal |
| Texto apagado | `#8b949e` | Etiquetas, ayudas |
| **Acento (marca)** | `#7c5cff` | Morado — color principal de Muxlyve |
| Acento 2 | `#4da3ff` | Azul — degradado del logo |
| Éxito / en vivo | `#2ea043` | Verde — reenviando, ON |
| Aviso | `#f0a23a` | Ámbar — reconectando |
| Peligro | `#f85149` | Rojo — error, LIVE, borrar |

El degradado de marca va de `#7c5cff` (morado) a `#4da3ff` (azul), en diagonal.

## Tipografía

- Interfaz: `system-ui, -apple-system, "Segoe UI", sans-serif`. Sin fuentes externas (cero dependencias, carga instantánea).
- Código / claves / URLs: `ui-monospace, monospace`.
- Pesos: solo **400** (normal) y **500/600** (semibold para títulos y botones). Nada más pesado.

## Wordmark

`Muxlyve` con la sílaba final **"ve"** en color de acento morado: `Muxly` (texto principal) + `ve` (morado). En contextos compactos o cuadrados, usar solo el icono del lobo.

## Tono

Serio pero cercano: herramienta de creador, no software corporativo. Mensajes claros y directos en español. Sin jerga innecesaria en la interfaz.

## Uso en el panel

Integrar `logo-muxlyve.svg` en la cabecera (reemplazar el `<h1>` de texto), y `icon-muxlyve.svg` como favicon (`<link rel="icon" href="/icon-muxlyve.svg">`). El panel ya usa esta paleta, así que la integración es directa.
