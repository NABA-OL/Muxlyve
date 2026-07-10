// Desarrollado por BlacKraken Solutions (NABA-OL)
// Valida que el <script> embebido en PANEL_HTML (src/panel.js) sea JS sintácticamente
// válido en el navegador. PANEL_HTML es un único template literal gigante — cualquier
// backtick sin escapar, o secuencia \X no reconocida (\/, \n, \', etc.) dentro de ese
// bloque se colapsa/rompe al evaluarse en Node, produciendo un <script> corrupto que
// solo falla en tiempo de EJECUCIÓN del navegador (silencioso: la UI se queda a medias
// sin ningún error visible). `node --check src/panel.js` NO detecta esto porque el
// template literal en sí es sintácticamente válido para Node.
//
// Importa PANEL_HTML ya evaluado (no regex sobre el texto crudo) para que Node procese
// los backticks escapados (\`) y demás igual que en producción — evita falsos positivos
// en patrones intencionales como `card.innerHTML = \`...\`;` dentro del <script>.
//
// Uso: node scripts/validate-panel-script.mjs  (o vía `npm run validate:panel`)
import { PANEL_HTML } from '../src/panel.js';

const scriptMatch = PANEL_HTML.match(/<script>([\s\S]*)<\/script>/);
if (!scriptMatch) {
  console.error('[validate-panel-script] No se encontró <script>...</script> dentro de PANEL_HTML.');
  process.exit(1);
}

try {
  new Function(scriptMatch[1]);
  console.log('[validate-panel-script] OK — el <script> del panel es válido para el navegador.');
} catch (err) {
  console.error('[validate-panel-script] ERROR de sintaxis en el <script> servido al navegador:');
  console.error('  ' + err.message);
  console.error('  Causa típica: un backslash (\\/, \\n, \\\') o backtick sin escapar dentro del');
  console.error('  template literal PANEL_HTML que se colapsa al evaluarse en Node. Revisa regex');
  console.error('  literales y strings con backslashes en el bloque <script> de src/panel.js.');
  process.exit(1);
}
