import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadAll, saveAll, isValidUrl, isPlayable } from './destinations.js';
import { isLive, isRelaying, applyChange, stopByName } from './relays.js';

const MAX_NAME = 40;
const MAX_URL = 500;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// flv.js auto-hospedado (sin CDN): cargado una vez al arrancar.
const FLV_JS = readFileSync(path.join(__dirname, 'public', 'flv.min.js'));

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// Estado que ve el panel: emisión activa + cada destino con su flag de reenvío en vivo.
function buildState() {
  const destinations = loadAll().map((d) => ({
    name: d.name,
    url: d.url || '',
    enabled: Boolean(d.enabled),
    note: d._nota || '',
    playable: isPlayable(d),
    relaying: isRelaying(d.name),
  }));
  return { live: isLive(), destinations };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('payload demasiado grande')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

// Valida la entrada del panel en el límite de confianza antes de tocar el archivo o ffmpeg.
function validateDestination(input) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const enabled = Boolean(input.enabled);
  if (!name) return { error: 'El nombre es obligatorio.' };
  if (name.length > MAX_NAME) return { error: `Nombre máximo ${MAX_NAME} caracteres.` };
  if (url.length > MAX_URL) return { error: `URL máxima ${MAX_URL} caracteres.` };
  // Solo exigimos URL válida si se quiere habilitar (TikTok puede quedar deshabilitado con placeholder).
  if (enabled && !isValidUrl(url)) {
    return { error: 'Para activar, la URL debe empezar por rtmp:// o rtmps:// y no ser un placeholder.' };
  }
  return { dest: { name, url, enabled } };
}

async function handleApi(req, res, url) {
  // GET /api/state
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, buildState());
  }

  // POST /api/destinations  -> upsert por nombre (crear, editar URL, toggle ON/OFF, clave TikTok)
  if (req.method === 'POST' && url.pathname === '/api/destinations') {
    let input;
    try { input = await readBody(req); }
    catch (err) { return json(res, 400, { error: err.message }); }
    const { error, dest } = validateDestination(input);
    if (error) return json(res, 400, { error });

    const list = loadAll();
    const idx = list.findIndex((d) => d.name === dest.name);
    const next = idx >= 0
      ? list.map((d, i) => (i === idx ? { ...d, url: dest.url, enabled: dest.enabled } : d))
      : [...list, dest];
    saveAll(next);
    applyChange(dest); // arranca/para el relay en caliente si hay emisión
    return json(res, 200, buildState());
  }

  // DELETE /api/destinations?name=X
  if (req.method === 'DELETE' && url.pathname === '/api/destinations') {
    const name = url.searchParams.get('name');
    if (!name) return json(res, 400, { error: 'Falta el parámetro name.' });
    stopByName(name);
    saveAll(loadAll().filter((d) => d.name !== name));
    return json(res, 200, buildState());
  }

  return json(res, 404, { error: 'No encontrado.' });
}

export function startPanel(port, config = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    try {
      // Config del ingest (URL/clave/preview) — estática, el panel la pide una vez.
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return json(res, 200, {
          rtmpUrl: config.rtmpUrl || '',
          streamKey: config.streamKey || '',
          flvUrl: config.flvUrl || '',
        });
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname === '/flv.min.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        return res.end(FLV_JS);
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PANEL_HTML);
      }
      res.writeHead(404).end('No encontrado');
    } catch (err) {
      console.error('[panel] error:', err.message);
      json(res, 500, { error: 'Error interno del panel.' });
    }
  });
  // Solo localhost: el panel nunca debe quedar expuesto en la red.
  server.listen(port, '127.0.0.1', () => {
    console.log(` Panel web:    http://localhost:${port}`);
  });
  return server;
}

const PANEL_HTML = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Multi_Stream — Panel</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --surface-2: #1c2230; --border: #2a3140;
    --text: #e6edf3; --muted: #8b949e; --accent: #7c5cff; --accent-2: #2ea043;
    --danger: #f85149; --live: #2ea043; --off: #484f58;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; justify-content: space-between;
    gap: 1rem; padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--border);
    background: var(--surface); position: sticky; top: 0; z-index: 5; }
  h1 { font-size: 1.15rem; margin: 0; letter-spacing: -0.01em; }
  h1 span { color: var(--accent); }
  .status { display: flex; align-items: center; gap: .5rem; font-size: .85rem;
    color: var(--muted); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--off);
    box-shadow: 0 0 0 0 transparent; transition: .3s; }
  .dot.on { background: var(--live); box-shadow: 0 0 0 4px rgba(46,160,67,.18); }
  main { max-width: 760px; margin: 0 auto; padding: 1.5rem; }
  .grid { display: grid; gap: 1rem; }
  .card { background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 1.1rem 1.2rem; }
  .card.tiktok { border-color: var(--accent); }
  .card-head { display: flex; align-items: center; gap: .6rem; margin-bottom: .8rem; }
  .card-head .name { font-weight: 600; font-size: 1.05rem; flex: 1; }
  .pill { font-size: .7rem; padding: .15rem .5rem; border-radius: 999px;
    background: var(--surface-2); color: var(--muted); }
  .pill.relaying { background: rgba(46,160,67,.15); color: var(--live); }
  label { display: block; font-size: .75rem; color: var(--muted); margin: 0 0 .25rem; }
  input[type=text] { width: 100%; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 8px; padding: .55rem .65rem; font-size: .9rem;
    font-family: ui-monospace, monospace; }
  input[type=text]:focus { outline: none; border-color: var(--accent); }
  .row { display: flex; gap: .6rem; align-items: flex-end; margin-top: .8rem; }
  .row .field { flex: 1; }
  button { cursor: pointer; border: none; border-radius: 8px; padding: .55rem .9rem;
    font-size: .85rem; font-weight: 600; transition: .15s; }
  button:active { transform: translateY(1px); }
  .toggle { min-width: 92px; background: var(--off); color: var(--text); }
  .toggle.on { background: var(--accent-2); }
  .save { background: var(--accent); color: #fff; }
  .del { background: transparent; color: var(--danger); border: 1px solid var(--border); }
  .note { font-size: .78rem; color: var(--muted); margin-top: .6rem; }
  .add { margin-top: 1.25rem; }
  .add summary { cursor: pointer; color: var(--accent); font-weight: 600; }
  #msg { position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%);
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
    padding: .6rem 1rem; border-radius: 8px; opacity: 0; transition: .3s; pointer-events: none; }
  #msg.show { opacity: 1; }
  #msg.err { border-color: var(--danger); color: var(--danger); }
  .preview { margin-bottom: 1.5rem; }
  .video-wrap { position: relative; background: #000; border: 1px solid var(--border);
    border-radius: 12px; overflow: hidden; aspect-ratio: 16 / 9; }
  .video-wrap video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .video-ph { position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; color: var(--muted); font-size: .9rem; text-align: center; padding: 1rem; }
  .conn { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; margin-top: .8rem; }
  .conn .field { background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: .5rem .65rem; }
  .conn .copyrow { display: flex; gap: .4rem; align-items: center; }
  .conn .copyrow code { flex: 1; font-family: ui-monospace, monospace; font-size: .82rem;
    color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conn button { background: var(--surface-2); color: var(--muted); padding: .3rem .55rem;
    font-size: .75rem; }
  .conn button:hover { color: var(--text); }
  @media (max-width: 560px) { .conn { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Multi<span>_</span>Stream</h1>
  <div class="status"><span class="dot" id="liveDot"></span><span id="liveTxt">comprobando…</span></div>
</header>
<main>
  <section class="preview">
    <div class="video-wrap">
      <video id="player" muted playsinline></video>
      <div class="video-ph" id="videoPh">Esperando señal de OBS…</div>
    </div>
    <div class="conn">
      <div class="field">
        <label>Servidor RTMP (en OBS)</label>
        <div class="copyrow"><code id="rtmpUrl">—</code><button onclick="copy('rtmpUrl')">copiar</button></div>
      </div>
      <div class="field">
        <label>Clave de retransmisión</label>
        <div class="copyrow"><code id="streamKey">—</code><button onclick="copy('streamKey')">copiar</button></div>
      </div>
    </div>
  </section>
  <div class="grid" id="list"></div>
  <details class="add">
    <summary>+ Añadir destino</summary>
    <div class="card" style="margin-top:.8rem">
      <div class="field"><label>Nombre</label><input type="text" id="newName" placeholder="MiPlataforma"></div>
      <div class="row">
        <div class="field"><label>URL RTMP</label><input type="text" id="newUrl" placeholder="rtmp://servidor/app/CLAVE"></div>
        <button class="save" onclick="addDest()">Añadir</button>
      </div>
    </div>
  </details>
</main>
<div id="msg"></div>
<script src="/flv.min.js"></script>
<script>
  const $ = (s) => document.querySelector(s);
  const list = $('#list');
  let msgTimer;
  let flvUrl = '';
  let player = null;

  function toast(text, isErr) {
    const m = $('#msg');
    m.textContent = text;
    m.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => (m.className = ''), 2500);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    return data;
  }

  function render(state) {
    $('#liveDot').className = 'dot' + (state.live ? ' on' : '');
    $('#liveTxt').textContent = state.live ? 'OBS en vivo' : 'esperando a OBS';
    updatePreview(state.live);
    list.innerHTML = '';
    for (const d of state.destinations) {
      const isTikTok = /tiktok/i.test(d.name);
      const card = document.createElement('div');
      card.className = 'card' + (isTikTok ? ' tiktok' : '');
      card.innerHTML = \`
        <div class="card-head">
          <span class="name"></span>
          <span class="pill\${d.relaying ? ' relaying' : ''}">\${d.relaying ? '● reenviando' : (d.enabled ? 'activo' : 'apagado')}</span>
        </div>
        <div class="field">
          <label>URL RTMP\${isTikTok ? ' — pega aquí la clave temporal de TikTok' : ''}</label>
          <input type="text" class="url" value="">
        </div>
        <div class="row">
          <button class="toggle\${d.enabled ? ' on' : ''}">\${d.enabled ? 'ON' : 'OFF'}</button>
          <button class="save">Guardar</button>
          <button class="del">Borrar</button>
        </div>
        \${d.note ? '<p class="note">' + '⚠ ' + '</p>' : ''}
      \`;
      card.querySelector('.name').textContent = d.name;
      const urlInput = card.querySelector('.url');
      urlInput.value = d.url;
      if (d.note) card.querySelector('.note').textContent = '⚠ ' + d.note;

      card.querySelector('.toggle').onclick = () =>
        save(d.name, urlInput.value, !d.enabled);
      card.querySelector('.save').onclick = () =>
        save(d.name, urlInput.value, d.enabled);
      card.querySelector('.del').onclick = () => del(d.name);
      list.appendChild(card);
    }
  }

  async function save(name, url, enabled) {
    try { render(await api('POST', '/api/destinations', { name, url, enabled }));
      toast(enabled ? name + ' activado' : name + ' guardado'); }
    catch (e) { toast(e.message, true); refresh(); }
  }
  async function del(name) {
    if (!confirm('¿Borrar ' + name + '?')) return;
    try { render(await api('DELETE', '/api/destinations?name=' + encodeURIComponent(name)));
      toast(name + ' borrado'); }
    catch (e) { toast(e.message, true); }
  }
  async function addDest() {
    const name = $('#newName').value.trim();
    const url = $('#newUrl').value.trim();
    if (!name) return toast('Pon un nombre', true);
    try { render(await api('POST', '/api/destinations', { name, url, enabled: false }));
      $('#newName').value = ''; $('#newUrl').value = ''; toast(name + ' añadido'); }
    catch (e) { toast(e.message, true); }
  }
  async function refresh() {
    try { render(await api('GET', '/api/state')); } catch {}
  }

  function copy(id) {
    const text = $('#' + id).textContent;
    if (!text || text === '—') return;
    navigator.clipboard.writeText(text).then(() => toast('Copiado'), () => toast('No se pudo copiar', true));
  }

  // Arranca/para el reproductor flv.js según haya emisión. Solo crea el player
  // cuando OBS publica (si no, el FLV no existe y daría error).
  function updatePreview(live) {
    const ph = $('#videoPh');
    if (live && !player && flvUrl && window.flvjs && flvjs.isSupported()) {
      const video = $('#player');
      player = flvjs.createPlayer({ type: 'flv', url: flvUrl, isLive: true });
      player.attachMediaElement(video);
      player.load();
      player.play().catch(() => {});
      ph.style.display = 'none';
    } else if (!live && player) {
      player.destroy();
      player = null;
      ph.textContent = 'Esperando señal de OBS…';
      ph.style.display = 'flex';
    }
  }

  async function loadConfig() {
    try {
      const c = await api('GET', '/api/config');
      flvUrl = c.flvUrl || '';
      $('#rtmpUrl').textContent = c.rtmpUrl || '—';
      $('#streamKey').textContent = c.streamKey || '—';
    } catch {}
  }

  loadConfig();
  refresh();
  setInterval(refresh, 2000); // refleja estado en vivo y reenvíos activos
</script>
</body>
</html>`;
