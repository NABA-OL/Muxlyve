# Multi_Stream — Identidad visual

Guía de marca mínima para mantener coherencia en el panel, el README y un futuro sitio del producto.

## Concepto

El logo representa el corazón del producto: **una sola fuente que se reparte en varios destinos**. Un nodo de origen (izquierda) del que salen cuatro líneas curvas hacia cuatro nodos de destino, cada uno con el color de una plataforma. Es la misma idea del diagrama de arquitectura, convertida en marca.

Archivos:
- `src/public/logo.svg` — logo horizontal con wordmark (para cabeceras).
- `src/public/icon.svg` — icono cuadrado 64×64 (para favicon, app icon, redes).

## Paleta

| Rol | Color | Uso |
|---|---|---|
| Fondo | `#0d1117` | Fondo principal (oscuro) |
| Superficie | `#161b22` | Tarjetas, cabecera |
| Superficie 2 | `#1c2230` | Inputs, chips |
| Borde | `#2a3140` | Separadores |
| Texto | `#e6edf3` | Texto principal |
| Texto apagado | `#8b949e` | Etiquetas, ayudas |
| **Acento (marca)** | `#7c5cff` | Morado — color principal de Multi_Stream |
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

`Multi_Stream` siempre con el guion bajo en color de acento: Multi · `_` morado · Stream. En contextos de una sola palabra, usar el icono.

## Tono

Serio pero cercano: herramienta de creador, no software corporativo. Mensajes claros y directos en español. Sin jerga innecesaria en la interfaz.

## Uso en el panel

Integrar `logo.svg` en la cabecera (reemplazar el `<h1>` de texto), y `icon.svg` como favicon (`<link rel="icon" href="/icon.svg">`). El panel ya usa esta paleta, así que la integración es directa.
