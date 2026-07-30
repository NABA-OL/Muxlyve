// Propiedad de BlacKraken Solutions
// Desarrollado por NABA-OL
// Valida que TODO el JS que le llega al navegador (inline en los 3 HTML de src/panel.js,
// y los .js externos de src/public/ que esos HTML cargan con <script src="...">) sea
// sintácticamente válido. Los HTML son template literals gigantes — cualquier backtick
// sin escapar, o secuencia \X no reconocida (\/, \n, \', etc.) dentro de ellos se
// colapsa/rompe al evaluarse en Node, produciendo un <script> corrupto que solo falla en
// tiempo de EJECUCIÓN del navegador (silencioso: la UI se queda a medias sin ningún error
// visible). `node --check src/panel.js` NO detecta esto porque el template literal en sí
// es sintácticamente válido para Node — por eso existe este script.
//
// Desde la Fase 1 del refactor (docs/PLAN_REFACTOR_PANEL.md), parte del JS ya vive en
// archivos reales bajo src/public/ (chat-window.js, y eventualmente panel-client.js) —
// esos ya no tienen el problema de escapado, pero igual se chequean acá para tener un
// solo comando que valida "todo lo que carga el navegador", sin tener que acordarse de
// revisar cada .js nuevo por separado.
//
// Uso: node scripts/validate-panel-script.mjs  (o vía `npm run validate:panel`)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_HTML, CHAT_WINDOW_HTML, CHAT_OVERLAY_HTML } from '../src/panel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'public');

const TARGETS = [
  ['PANEL_HTML', PANEL_HTML],
  ['CHAT_WINDOW_HTML', CHAT_WINDOW_HTML],
  ['CHAT_OVERLAY_HTML', CHAT_OVERLAY_HTML],
];

let failed = false;

function checkSource(label, code) {
  try {
    new Function(code);
    console.log(`[validate-panel-script] OK — ${label}`);
  } catch (err) {
    console.error(`[validate-panel-script] ERROR de sintaxis en ${label}:`);
    console.error('  ' + err.message);
    failed = true;
  }
}

for (const [name, html] of TARGETS) {
  // <script>...</script> inline (sin atributo src).
  const inlineMatches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  if (inlineMatches.length === 0) {
    console.log(`[validate-panel-script] (${name} no tiene <script> inline — todo su JS es externo, ver abajo)`);
  }
  for (const m of inlineMatches) checkSource(`<script> inline de ${name}`, m[1]);

  // <script src="/archivo.js"></script> — solo rutas locales (empiezan con /), resueltas
  // contra src/public/. Ignora URLs externas (no debería haber ninguna, CSP script-src
  // 'self' las bloquearía igual).
  const srcMatches = [...html.matchAll(/<script[^>]*\bsrc="(\/[^"]+\.js)"[^>]*><\/script>/g)];
  for (const m of srcMatches) {
    const rel = m[1].slice(1); // saca el "/" inicial
    const filePath = path.join(PUBLIC_DIR, rel);
    let code;
    try {
      code = readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.error(`[validate-panel-script] ${name} referencia src="${m[1]}" pero no existe en src/public/ (${err.message}).`);
      failed = true;
      continue;
    }
    checkSource(`src/public/${rel} (cargado por ${name})`, code);
  }
}

if (failed) {
  console.error('[validate-panel-script] Causa típica de error en un HTML: un backslash');
  console.error('  (\\/, \\n, \\\') o backtick sin escapar dentro del template literal que se');
  console.error('  colapsa al evaluarse en Node. Revisa regex literales y strings con');
  console.error('  backslashes en el bloque <script> de src/panel.js.');
  process.exit(1);
}
console.log('[validate-panel-script] Todo el JS que carga el navegador es sintácticamente válido.');
