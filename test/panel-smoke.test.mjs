// Desarrollado por BlacKraken Solutions (NABA-OL)
// Contrato del refactor de docs/PLAN_REFACTOR_PANEL.md — este test tiene que pasar ANTES
// y DESPUÉS de cada fase. Si pasa en ambos lados, el ruteo/servido no se rompió al mover
// código. No valida contenido pixel a pixel, solo que cada endpoint/asset siga
// respondiendo con el status/content-type/anclas esperadas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'muxlyve-test-panel-smoke-'));
process.env.MS_CONFIG_DIR = tmpDir;
delete process.env.MASTER_KEY;

const { startPanel } = await import('../src/panel.js');

const PORT = 19199; // puerto fijo de prueba, no pisa el rango que usa la app real (19080)
const BASE = `http://127.0.0.1:${PORT}`;
let server;

before(() => {
  server = startPanel(PORT, {
    rtmpUrl: 'rtmp://localhost:19350/live',
    lanRtmpUrl: null,
    lanIp: null,
    rtmpPort: 19350,
    httpPort: 19000,
    version: '0.0.0-test',
  });
});

after(() => {
  server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('GET /api/state -> 200 con las claves esperadas', async () => {
  const res = await fetch(`${BASE}/api/state`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok('live' in data);
  assert.ok('uptime' in data);
  assert.ok(Array.isArray(data.destinations));
  assert.ok('recorder' in data);
});

test('GET / -> 200, text/html, con anclas de las features de esta sesión', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  // Anclas del chat/pin (sesión anterior).
  assert.match(body, /id="chatMessages"/);
  assert.match(body, /id="confirmOverlay"/);
  assert.match(body, /id="promptOverlay"/);
  // Perfiles de destinos.
  assert.match(body, /id="presetChips"/);
  // Webhooks Discord/Telegram.
  assert.match(body, /id="discordWebhooksList"/);
  assert.match(body, /id="telegramBotsList"/);
  assert.match(body, /id="discordMsgOverlay"/);
  // Feedback.
  assert.match(body, /id="feedbackOverlay"/);
  // Comando !clip.
  assert.match(body, /id="chatCmdChk"/);
});

test('GET /chat-window -> 200 text/html', async () => {
  const res = await fetch(`${BASE}/chat-window`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('GET /chat-overlay -> 200 text/html', async () => {
  const res = await fetch(`${BASE}/chat-overlay`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('assets estáticos -> 200 con content-type correcto', async () => {
  const cases = [
    ['/flv.min.js', /javascript/],
    ['/icon-muxlyve.svg', /svg/],
    ['/logo-muxlyve.svg', /svg/],
    ['/connections.svg', /svg/],
    ['/chat.svg', /svg/],
    ['/video-off.svg', /svg/],
    ['/webhook.svg', /svg/],
  ];
  for (const [route, contentTypeRe] of cases) {
    const res = await fetch(`${BASE}${route}`);
    assert.equal(res.status, 200, `${route} debería responder 200`);
    assert.match(res.headers.get('content-type'), contentTypeRe, `${route} content-type`);
  }
});

test('GET /api/config -> 200 con los campos de settings multi-webhook', async () => {
  const res = await fetch(`${BASE}/api/config`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.discordWebhooks));
  assert.ok(Array.isArray(data.telegramBots));
  assert.equal(typeof data.chatCommandsEnabled, 'boolean');
});

test('GET /api/presets -> 200 con array de perfiles', async () => {
  const res = await fetch(`${BASE}/api/presets`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.presets));
});

test('ruta inexistente -> 404', async () => {
  const res = await fetch(`${BASE}/no-existe-esto`);
  assert.equal(res.status, 404);
});
