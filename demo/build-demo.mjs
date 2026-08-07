// Desarrollado por "BlacKraken Solutions"
// Correo: nabaol.dev@gmail.com
// Fecha: 2026-08-05
//
// Genera demo/dist/ — una copia 100% estática del panel real (mismo HTML/CSS/JS que sirve
// src/panel.js, sin tocarlos) con demo-mock.js inyectado antes de los scripts reales para
// que ningún fetch/EventSource salga a la red. Sin Node corriendo, sin OBS, sin FFmpeg —
// pensado para desplegar en cualquier hosting estático y embeber por iframe en la web
// (ver docs/WEBSITE_UPDATE_LOTE2.md para el resto de material de marketing).
//
// Reusa PANEL_HTML tal cual (import directo de src/panel.js) para que la demo nunca se
// desincronice del panel real — cualquier cambio de UI en la app se refleja acá con solo
// volver a correr este script.
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_HTML } from '../src/panel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_SRC = path.join(ROOT, 'src', 'public');
const DIST = path.join(__dirname, 'dist');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// Copia completa de src/public/ — panel.css, panel-client.js, chat-render.js, flv.min.js,
// SVGs. Todo lo que PANEL_HTML referencia con rutas absolutas (/panel.css, etc.) ya vive
// acá con ese mismo nombre, así que sirve tal cual en la raíz del hosting estático.
cpSync(PUBLIC_SRC, DIST, { recursive: true });

// demo-mock.js va en la raíz junto a los demás — se referencia como /demo-mock.js.
cpSync(path.join(__dirname, 'demo-mock.js'), path.join(DIST, 'demo-mock.js'));

const DEMO_BADGE = `<div id="demoBadge" style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#6d28d9;color:#fff;font:600 .78rem/1 system-ui,sans-serif;text-align:center;padding:.45rem;pointer-events:none">Demo — datos de muestra, no es una transmisión real</div>`;

let html = PANEL_HTML
  // demo-mock.js debe cargar ANTES que flv.min.js/chat-render.js/panel-client.js para
  // interceptar fetch/EventSource desde el primer momento.
  .replace('<script src="/flv.min.js"></script>', `<script src="/demo-mock.js"></script>\n<script src="/flv.min.js"></script>`)
  .replace('<header>', `${DEMO_BADGE}\n<header style="margin-top:2rem">`);

writeFileSync(path.join(DIST, 'index.html'), html);

console.log(`[build-demo] listo — ${DIST}`);
console.log('[build-demo] servir con cualquier servidor estático, ej.: npx serve demo/dist');
