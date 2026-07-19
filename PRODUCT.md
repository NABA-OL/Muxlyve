# Product

## Register

product

## Users

Streamers que transmiten a varias plataformas a la vez (Twitch, Kick, YouTube, TikTok Live).
Contexto: en vivo frente a OBS, necesitan encender/apagar destinos al instante, ver estado de
cada relay y el chat unificado sin salir de la app. Usan Muxlyve como herramienta de escritorio
local (Windows/macOS), no como servicio web.

## Product Purpose

Motor de restreaming propio y gratuito, sin marca de agua, que recibe la señal de OBS por RTMP
local y la reenvía a N plataformas vía FFmpeg. El panel local es el centro de control: gestionar
destinos, ver estado de conexión en vivo, preview del stream y chat unificado. Éxito = salir en
vivo a múltiples plataformas sin fricción y sin pagar por ello.

## Brand Personality

Moderno, limpio, premium. Herramienta seria de pago-percibido, no juguete. Confianza por
claridad y control, no por decoración.

## Anti-references

- SaaS genérico "crema": fondo cálido near-white, hero-metric con gran número, tarjetas idénticas.
- Clon descarado de Restream/OBS: no imitar su layout uno a uno.
- Estética "gaming" neon sobrecargada: neones brillosos, sombras difusas de colores saturados.

## Design Principles

- Control antes que decoración: el estado de cada relay debe leerse en <1s (verde/ámbar/rojo).
- Claridad en vivo: texto y contraste que aguanten pantalla de streaming a la vez que OBS.
- Premium por acabado, no por ruido: espaciado generoso, tipografía sobria, un acento.
- Sin sorpresas: toggles en vivo arrancan/paran el relay de inmediato y lo confirman.

## Accessibility & Inclusion

WCAG 2.1 AA. Contraste 4.5:1 en texto, 3:1 en grandes/UI; foco visible; soporte de
`prefers-reduced-motion`; tema claro/oscuro ya presente, ambos deben cumplir AA.
