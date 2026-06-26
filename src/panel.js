import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadAll, saveAll, isValidUrl, isPlayable } from './destinations.js';
import { isLive, relayInfo, uptimeSeconds, applyChange, stopByName, retry, recorderInfo, startRecording, stopRecording, saveClip } from './relays.js';

const MAX_NAME = 40;
const MAX_URL = 500;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
// Assets estáticos auto-hospedados (sin CDN): cargados una vez al arrancar.
const FLV_JS = readFileSync(path.join(PUBLIC, 'flv.min.js'));
const LOGO_SVG       = readFileSync(path.join(PUBLIC, 'logo-muxlyve.svg'));
const LOGO_SVG_LIGHT = readFileSync(path.join(PUBLIC, 'logo-muxlyve-light.svg'));
const ICON_SVG       = readFileSync(path.join(PUBLIC, 'icon-muxlyve.svg'));

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// Estado que ve el panel: emisión activa, uptime y cada destino con su estado/métricas.
function buildState() {
  const destinations = loadAll().map((d) => {
    const info = relayInfo(d.name);
    return {
      name: d.name,
      url: d.url || '',
      enabled: Boolean(d.enabled),
      note: d._nota || '',
      playable: isPlayable(d),
      relaying: info.status === 'live' || info.status === 'connecting',
      status: info.status,
      attempts: info.attempts,
      metrics: info.metrics,
      lagging: info.lagging,
    };
  });
  return { live: isLive(), uptime: uptimeSeconds(), destinations, recorder: recorderInfo() };
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
    return { error: 'Para activar, la URL debe empezar por rtmp://, rtmps:// o srt:// y no ser un placeholder.' };
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

  // POST /api/retry?name=X  -> reintento manual de un destino 'failed'
  if (req.method === 'POST' && url.pathname === '/api/retry') {
    const name = url.searchParams.get('name');
    const dest = loadAll().find((d) => d.name === name);
    if (!dest) return json(res, 404, { error: 'Destino no encontrado.' });
    retry(dest);
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

  // POST /api/record/start  { duration: 30|60|120 }
  if (req.method === 'POST' && url.pathname === '/api/record/start') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const dur = [30, 60, 120].includes(Number(input.duration)) ? Number(input.duration) : 60;
    if (!isLive()) return json(res, 409, { error: 'OBS no está transmitiendo.' });
    startRecording(dur);
    return json(res, 200, buildState());
  }

  // POST /api/record/stop
  if (req.method === 'POST' && url.pathname === '/api/record/stop') {
    stopRecording();
    return json(res, 200, buildState());
  }

  // POST /api/record/save  { duration: 30|60|120, outputDir?: string }
  if (req.method === 'POST' && url.pathname === '/api/record/save') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const dur = [30, 60, 120].includes(Number(input.duration)) ? Number(input.duration) : 60;
    const outputDir = typeof input.outputDir === 'string' && input.outputDir.trim() ? input.outputDir.trim() : null;
    try {
      const filePath = await saveClip(dur, outputDir);
      return json(res, 200, { ok: true, path: filePath });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // GET /api/pick-folder  → abre el selector nativo de carpetas (solo Electron)
  if (req.method === 'GET' && url.pathname === '/api/pick-folder') {
    try {
      const { dialog, BrowserWindow } = await import('electron');
      const win = BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Carpeta de clips' });
      return json(res, 200, { path: result.canceled ? null : result.filePaths[0] });
    } catch {
      return json(res, 501, { error: 'Selector solo disponible en la app de escritorio.' });
    }
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
      if (url.pathname === '/logo-muxlyve.svg' || url.pathname === '/logo-muxlyve-light.svg' || url.pathname === '/icon-muxlyve.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
        if (url.pathname === '/icon-muxlyve.svg') return res.end(ICON_SVG);
        return res.end(url.pathname === '/logo-muxlyve-light.svg' ? LOGO_SVG_LIGHT : LOGO_SVG);
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
  server.on('error', (err) => {
    console.error(`[panel] ERROR al iniciar en puerto ${port}:`, err.code, err.message);
  });
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
<title>Muxlyve — Panel</title>
<link rel="icon" href="/icon-muxlyve.svg">
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --surface-2: #1c2230; --border: #2a3140;
    --text: #e6edf3; --muted: #8b949e; --accent: #7c5cff; --accent-2: #2ea043;
    --danger: #f85149; --live: #2ea043; --warn: #f0a23a; --off: #484f58;
    --header-h: 68px;
  }
  [data-theme="light"] {
    --bg: #f0f2f5; --surface: #ffffff; --surface-2: #e8eaef; --border: #d0d4de;
    --text: #1a1a2e; --muted: #5a6070; --accent: #7c5cff; --accent-2: #1a8a35;
    --danger: #cc2222; --live: #1a8a35; --warn: #b07020; --off: #a8adb8;
  }
  * { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--muted); }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }

  /* ── Header ── */
  header { display: flex; align-items: center; justify-content: space-between;
    gap: 1rem; padding: 1rem 1.5rem; border-bottom: 1px solid var(--border);
    background: var(--surface); position: sticky; top: 0; z-index: 5;
    height: var(--header-h); }
  .logo-wrap { display: flex; align-items: center; gap: .55rem; flex-shrink: 0; text-decoration: none; }
  .logo-icon { height: 32px; width: 32px; object-fit: contain; }
  .wordmark { font-size: 1.1rem; font-weight: 700; letter-spacing: -.03em; cursor: default; user-select: none; color: var(--text); }
  .wm-ve { color: var(--accent); }
  .wm-li {
    display: inline-block; overflow: hidden; max-width: 0; opacity: 0;
    transition: max-width .7s cubic-bezier(.4,0,.2,1), opacity .55s;
    vertical-align: bottom;
  }
  .wm-li { color: var(--accent); }
  .wm-li.show { max-width: 2.4ch; opacity: 1; }
  @media (prefers-reduced-motion: reduce) { .wm-li { transition: none; } }
  .status { display: flex; align-items: center; gap: .5rem; font-size: .85rem; color: var(--muted); }
  .status .uptime { font-variant-numeric: tabular-nums; color: var(--text); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--off);
    box-shadow: 0 0 0 0 transparent; transition: .3s; }
  .dot.on { background: var(--live); box-shadow: 0 0 0 4px rgba(46,160,67,.18); }
  .header-actions { display: flex; align-items: center; gap: .3rem; }

  /* ── Canvas fondo ── */
  #bgCanvas { position: fixed; inset: 0; width: 100%; height: 100%;
    pointer-events: none; z-index: 0; opacity: .55; }
  header, main, .prefs-overlay { position: relative; z-index: 1; }

  /* ── Sidebar colapsable ── */
  html, body { height: 100%; overflow: hidden; }
  main { padding: 0; display: flex; height: calc(100vh - var(--header-h)); overflow: hidden; }
  .main-col { flex: 1 1 0; min-width: 0; overflow-y: auto; padding: 1.25rem 1.5rem; }
  .sidebar-col {
    flex: 0 0 360px; width: 360px; min-width: 0;
    border-left: 1px solid var(--border);
    display: flex; flex-direction: column;
    transition: flex-basis .22s cubic-bezier(.4,0,.2,1), width .22s cubic-bezier(.4,0,.2,1);
    overflow: hidden;
  }
  .sidebar-col.collapsed { flex-basis: 0; width: 0; }
  .sidebar-inner { flex: 1; overflow-y: auto; padding: 1.25rem 1.5rem; min-width: 360px;
    display: flex; flex-direction: column; gap: 1rem; }
  .sidebar-toggle-btn {
    background: transparent; border: 1px solid var(--border); border-radius: 8px;
    color: var(--muted); cursor: pointer; padding: .35rem .5rem;
    display: flex; align-items: center; line-height: 1; font-weight: 400;
    transition: color .15s, border-color .15s;
  }
  .sidebar-toggle-btn:hover { color: var(--text); border-color: var(--muted); }
  .sidebar-toggle-btn.panel-open { border-color: var(--accent); color: var(--accent); }

  /* ── Toggle switch ── */
  .switch { position: relative; display: inline-block; width: 42px; height: 24px; flex-shrink: 0; }
  .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
  .switch .thumb {
    position: absolute; inset: 0; background: var(--off); border-radius: 12px;
    cursor: pointer; transition: background .2s;
  }
  .switch .thumb::before {
    content: ''; position: absolute; width: 18px; height: 18px;
    left: 3px; top: 3px; background: #fff; border-radius: 50%;
    transition: transform .2s;
  }
  .switch input:checked ~ .thumb { background: var(--accent); }
  .switch input:checked ~ .thumb::before { transform: translateX(18px); }

  /* ── Modal de Preferencias ── */
  .prefs-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,.5); z-index: 50;
    align-items: center; justify-content: center;
    backdrop-filter: blur(3px);
  }
  .prefs-overlay.open { display: flex; }
  .prefs-modal {
    background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
    padding: 1.5rem; width: 420px; max-width: 90vw;
    box-shadow: 0 24px 64px rgba(0,0,0,.5);
  }
  .prefs-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.25rem; }
  .prefs-head h2 { margin: 0; font-size: 1.05rem; font-weight: 600; }
  .prefs-close { background: transparent; color: var(--muted); border: 1px solid transparent;
    font-size: 1rem; padding: .2rem .45rem; border-radius: 6px; }
  .prefs-close:hover { color: var(--text); background: var(--surface-2); }
  .prefs-section h3 { font-size: .75rem; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: .06em; margin: 0 0 .75rem; }

  /* ── Modal licencia ── */
  .lic-modal { width: 380px; }
  .lic-row { display: flex; flex-direction: column; gap: .3rem; margin-bottom: 1rem; }
  .lic-label { font-size: .72rem; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
  .lic-value { font-size: .9rem; color: var(--text); font-family: ui-monospace, monospace; word-break: break-all; }
  .lic-danger { margin-top: .5rem; padding-top: 1rem; border-top: 1px solid var(--border); }
  .lic-status-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
  .lic-badge { font-size: .68rem; font-weight: 700; padding: .15rem .55rem; border-radius: 20px; text-transform: uppercase; letter-spacing: .06em; }
  .lic-badge.active   { background: rgba(46,160,67,.15);  color: #3fb950; border: 1px solid rgba(46,160,67,.3); }
  .lic-badge.cancelled{ background: rgba(210,153,34,.15); color: #d29922; border: 1px solid rgba(210,153,34,.3); }
  .lic-badge.lifetime { background: rgba(124,92,255,.15); color: #7c5cff; border: 1px solid rgba(124,92,255,.3); }
  .lic-manage-btn { width: 100%; padding: .45rem; background: transparent; border: 1px solid var(--border); color: var(--text); border-radius: 8px; font-size: .85rem; cursor: pointer; margin-bottom: .5rem; transition: background .15s; }
  .lic-manage-btn:hover { background: var(--surface-2); }
  .lic-danger-btn { width: 100%; padding: .5rem; background: transparent; border: 1px solid var(--danger); color: var(--danger); border-radius: 8px; font-size: .85rem; cursor: pointer; transition: background .15s; }
  .lic-danger-btn:hover { background: rgba(235,64,52,.12); }
  .lic-note { font-size: .72rem; color: var(--muted); margin: .5rem 0 0; line-height: 1.4; }

  /* ── Grabador de clips ── */
  .rec-section { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border); }
  .rec-section h3 { font-size: .75rem; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: .06em; margin: 0 0 .65rem; }
  .rec-dur { display: flex; gap: .4rem; margin-bottom: .65rem; }
  .rec-dur button { flex: 1; padding: .3rem .4rem; border: 1px solid var(--border);
    border-radius: 6px; background: var(--bg); color: var(--muted); font-size: .8rem; cursor: pointer; }
  .rec-dur button.sel { border-color: var(--accent); color: var(--accent); background: rgba(124,92,255,.1); }
  .rec-status { font-size: .78rem; color: var(--muted); margin-top: .5rem; min-height: 1.2em; }
  .rec-status.on { color: var(--live); }

  /* ── Preview ── */
  .preview { margin-bottom: 1rem; }
  .video-wrap { position: relative; background: #000; border: 1px solid var(--border);
    border-radius: 12px; overflow: hidden; aspect-ratio: 16 / 9; }
  .video-wrap video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .video-ph { position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; color: var(--muted); font-size: .88rem; text-align: center; padding: 1rem; }
  .conn { display: flex; flex-direction: column; gap: .5rem; margin-top: .75rem; }
  .conn .field { background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: .5rem .65rem; }
  .conn .copyrow { display: flex; gap: .4rem; align-items: center; }
  .conn .copyrow code { flex: 1; font-family: ui-monospace, monospace; font-size: .8rem;
    color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conn button { background: var(--surface-2); color: var(--muted); padding: .3rem .55rem;
    font-size: .75rem; border: none; border-radius: 6px; cursor: pointer; }
  .conn button:hover { color: var(--text); }

  /* ── Destination cards ── */
  .card { background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 1.1rem 1.2rem; }
  .card.tiktok { border-color: var(--accent); }
  .card-head { display: flex; align-items: center; gap: .6rem; margin-bottom: .8rem; }
  .card-head .name { font-weight: 600; font-size: 1rem; flex: 1; }
  .pill { font-size: .7rem; padding: .15rem .5rem; border-radius: 999px;
    background: var(--surface-2); color: var(--muted); white-space: nowrap; }
  .pill.live { background: rgba(46,160,67,.15); color: var(--live); }
  .pill.reconnecting { background: rgba(240,162,58,.15); color: var(--warn); }
  .pill.failed { background: rgba(248,81,73,.15); color: var(--danger); }
  .pill.lagging { background: rgba(240,162,58,.15); color: var(--warn); }
  .metrics { font-size: .72rem; color: var(--muted); margin-left: auto;
    font-variant-numeric: tabular-nums; white-space: nowrap; }
  .retry { background: var(--danger); color: #fff; }
  label { display: block; font-size: .75rem; color: var(--muted); margin: 0 0 .25rem; }
  input[type=text] { width: 100%; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 8px; padding: .5rem .65rem; font-size: .88rem;
    font-family: ui-monospace, monospace; }
  input[type=text]:focus { outline: none; border-color: var(--accent); }
  .row { display: flex; gap: .6rem; align-items: flex-end; margin-top: .75rem; }
  .row .field { flex: 1; }
  button { cursor: pointer; border: none; border-radius: 8px; padding: .5rem .85rem;
    font-size: .85rem; font-weight: 600; transition: .15s; }
  button:active { transform: translateY(1px); }
  .toggle { min-width: 100px; background: var(--off); color: var(--text); }
  .toggle.on { background: var(--accent-2); }
  .auto-note { font-size: .72rem; color: var(--muted); margin-top: .45rem; }
  .save { background: var(--accent); color: #fff; }
  .del { background: transparent; color: var(--danger); border: 1px solid var(--border); }
  .note { font-size: .78rem; color: var(--muted); margin-top: .6rem; }

  /* ── Add form ── */
  .add { margin-top: .25rem; }
  .add summary { cursor: pointer; color: var(--accent); font-weight: 600;
    padding: .75rem 0; list-style: none; }
  .add summary::-webkit-details-marker { display: none; }
  .add-card { background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 1rem 1.2rem; margin-top: .5rem; }

  /* ── Toast ── */
  #msg { position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%);
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
    padding: .6rem 1rem; border-radius: 8px; opacity: 0; transition: .3s; pointer-events: none;
    white-space: nowrap; z-index: 10; }
  #msg.show { opacity: 1; }
  #msg.err { border-color: var(--danger); color: var(--danger); }
</style>
</head>
<canvas id="bgCanvas" aria-hidden="true"></canvas>
<header>
  <div class="logo-wrap">
    <img src="/icon-muxlyve.svg" alt="" class="logo-icon">
    <span class="wordmark" role="img" aria-label="Muxlyve">Muxly<span class="wm-li" id="wmLi"> Li</span><span class="wm-ve">ve</span></span>
  </div>
  <div class="status">
    <span class="dot" id="liveDot"></span>
    <span id="liveTxt">comprobando…</span>
    <span class="uptime" id="uptime"></span>
  </div>
  <div class="header-actions">
    <button class="sidebar-toggle-btn" id="themeToggle" onclick="toggleTheme()" title="Cambiar tema">
      <!-- sun: mostrar cuando modo oscuro activo (click → claro) -->
      <svg id="iconSun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="4"/>
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
      </svg>
      <!-- moon: mostrar cuando modo claro activo (click → oscuro) -->
      <svg id="iconMoon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
    </button>
    <button class="sidebar-toggle-btn" id="prefsBtn" onclick="openPrefs()" title="Preferencias">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </button>
    <button class="sidebar-toggle-btn" id="licBtn" onclick="openLic()" title="Licencia">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
      </svg>
    </button>
    <button class="sidebar-toggle-btn panel-open" id="sidebarToggle" onclick="toggleSidebar()" title="Mostrar/ocultar conexiones">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="1" y="1" width="14" height="14" rx="2.5"/>
        <line x1="10" y1="1.5" x2="10" y2="14.5"/>
      </svg>
    </button>
  </div>
</header>
<main>
  <!-- Principal: preview + config OBS + grabador -->
  <div class="main-col">
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
        <!-- Grabador de clips -->
        <div class="rec-section">
          <div class="row">
            <button id="recToggle" disabled onclick="toggleRec()">Activar buffer</button>
            <button id="clipSaveBtn" style="display:none" onclick="doSaveClip()">Guardar clip</button>
          </div>
          <div class="rec-status" id="recStatus">Conecta OBS para usar el buffer.</div>
        </div>
      </section>
  </div>
  <!-- Sidebar colapsable: destinos -->
  <aside class="sidebar-col" id="sidebarCol">
    <div class="sidebar-inner">
      <div id="list"></div>
      <details class="add">
        <summary>+ Añadir destino</summary>
        <div class="add-card">
          <div class="field"><label>Nombre</label><input type="text" id="newName" placeholder="MiPlataforma"></div>
          <div class="row">
            <div class="field"><label>URL (rtmp:// · rtmps:// · srt://)</label><input type="text" id="newUrl" placeholder="rtmp://servidor/app/CLAVE"></div>
            <button class="save" onclick="addDest()">Añadir</button>
          </div>
        </div>
      </details>
    </div>
  </aside>
</main>
<!-- Modal de Preferencias -->
<div class="prefs-overlay" id="prefsOverlay" onclick="if(event.target===this)closePrefs()">
  <div class="prefs-modal">
    <div class="prefs-head">
      <h2>Preferencias</h2>
      <button class="prefs-close" onclick="closePrefs()">✕</button>
    </div>
    <div class="prefs-section">
      <h3>Grabador de clips</h3>
      <div style="margin-bottom:.85rem">
        <label style="display:block;font-size:.75rem;color:var(--muted);margin-bottom:.4rem">Duración del buffer</label>
        <div class="rec-dur">
          <button class="sel" data-dur="30" onclick="setRecDur(30)">30 s</button>
          <button data-dur="60" onclick="setRecDur(60)">1 min</button>
          <button data-dur="120" onclick="setRecDur(120)">2 min</button>
        </div>
      </div>
      <div class="field">
        <label>Carpeta de destino de clips</label>
        <div class="copyrow" style="gap:.4rem;margin-top:.35rem">
          <input type="text" id="clipsDir" placeholder="Predeterminada del sistema"
                 style="font-family:ui-monospace,monospace;font-size:.78rem"
                 oninput="localStorage.setItem('ms_clips_dir', this.value)">
          <button id="browseBtn" onclick="browseFolder()" title="Elegir carpeta">…</button>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="prefs-overlay" id="licOverlay" onclick="if(event.target===this)closeLic()">
  <div class="prefs-modal lic-modal">
    <div class="prefs-head">
      <h2>Licencia</h2>
      <button class="prefs-close" onclick="closeLic()">✕</button>
    </div>
    <div class="lic-row">
      <span class="lic-label">Correo</span>
      <span class="lic-value" id="licEmail">…</span>
    </div>
    <div class="lic-status-row">
      <div>
        <div class="lic-label" style="margin-bottom:.25rem">Plan</div>
        <span class="lic-value" id="licPlan">—</span>
      </div>
      <span class="lic-badge active" id="licBadge">—</span>
    </div>
    <div class="lic-row" id="licRenewRow">
      <span class="lic-label" id="licRenewLabel">Se renueva</span>
      <span class="lic-value" id="licRenewDate">—</span>
    </div>
    <div class="lic-row">
      <span class="lic-label">Activado</span>
      <span class="lic-value" id="licDate">—</span>
    </div>
    <div class="lic-danger">
      <button class="lic-manage-btn" id="licManageBtn"
        onclick="window.open('https://users.freemius.com','_blank')"
        style="display:none">Gestionar suscripción ↗</button>
      <button class="lic-danger-btn" onclick="releaseLic()">Liberar este equipo</button>
      <p class="lic-note">Podrás activar la app en otro equipo. Necesitarás tu clave para volver a activarla aquí.</p>
    </div>
  </div>
</div>
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

  function fmtUptime(s) {
    if (s == null) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return (h ? p(h) + ':' : '') + p(m) + ':' + p(sec);
  }

  // Devuelve { cls, text } para la píldora de estado de un destino.
  function pillFor(d) {
    if (d.status === 'live') {
      return d.lagging
        ? { cls: 'lagging', text: '⚠ rezagado' }
        : { cls: 'live', text: '● reenviando' };
    }
    if (d.status === 'connecting') return { cls: 'reconnecting', text: '⟳ conectando…' };
    if (d.status === 'reconnecting') return { cls: 'reconnecting', text: '⟳ reconectando… intento ' + d.attempts };
    if (d.status === 'failed') return { cls: 'failed', text: '✕ falló' };
    return { cls: '', text: d.enabled ? 'activo' : 'apagado' };
  }

  function metricsFor(d) {
    if (d.status !== 'live' || !d.metrics) return '';
    const parts = [];
    if (d.metrics.bitrate != null) parts.push(d.metrics.bitrate + ' kbps');
    if (d.metrics.fps != null) parts.push(d.metrics.fps + ' fps');
    if (d.metrics.speed != null) parts.push(d.metrics.speed + 'x');
    return parts.join(' · ');
  }

  function fmtDur(s) { return s < 60 ? s + 's' : (s / 60) + ' min'; }

  function updateRecorder(state) {
    const rec = state.recorder || { active: false, duration: 60 };
    const toggle = $('#recToggle');
    const saveBtn = $('#clipSaveBtn');
    const status = $('#recStatus');
    if (!state.live && !rec.active) {
      toggle.disabled = true;
      toggle.textContent = 'Activar buffer';
      toggle.dataset.active = '0';
      saveBtn.style.display = 'none';
      status.className = 'rec-status';
      status.textContent = 'Conecta OBS para usar el buffer.';
    } else if (rec.active) {
      toggle.disabled = false;
      toggle.textContent = 'Detener buffer';
      toggle.dataset.active = '1';
      saveBtn.style.display = '';
      status.className = 'rec-status on';
      status.textContent = '● Grabando — último ' + fmtDur(rec.duration) + ' disponible';
    } else {
      toggle.disabled = false;
      toggle.textContent = 'Activar buffer';
      toggle.dataset.active = '0';
      saveBtn.style.display = 'none';
      status.className = 'rec-status';
      status.textContent = state.live ? 'Buffer inactivo.' : 'OBS detuvo la emisión.';
    }
  }

  function render(state) {
    $('#liveDot').className = 'dot' + (state.live ? ' on' : '');
    $('#liveTxt').textContent = state.live ? 'OBS en vivo' : 'esperando a OBS';
    $('#uptime').textContent = state.live ? fmtUptime(state.uptime) : '';
    updatePreview(state.live);
    updateRecorder(state);
    list.innerHTML = '';
    for (const d of state.destinations) {
      const isTikTok = /tiktok/i.test(d.name);
      const pill = pillFor(d);
      const metrics = metricsFor(d);
      const card = document.createElement('div');
      card.className = 'card' + (isTikTok ? ' tiktok' : '');
      card.innerHTML = \`
        <div class="card-head">
          <span class="name"></span>
          <span class="pill \${pill.cls}"></span>
          <span class="metrics"></span>
        </div>
        <div class="field">
          <label>URL RTMP\${isTikTok ? ' — pega aquí la clave temporal de TikTok' : ''}</label>
          <input type="text" class="url" value="">
        </div>
        <div class="row">
          <label class="switch" title="\${d.enabled ? 'Desactivar' : 'Activar'}">
            <input type="checkbox" class="toggle-cb"\${d.enabled ? ' checked' : ''}>
            <span class="thumb"></span>
          </label>
          <button class="save">Guardar</button>
          \${d.status === 'failed' ? '<button class="retry">Reintentar</button>' : ''}
          <button class="del">Borrar</button>
        </div>
        \${d.enabled && !state.live ? '<p class="auto-note">▶ Arrancará cuando OBS empiece a transmitir.</p>' : ''}
        \${d.note ? '<p class="note"></p>' : ''}
      \`;
      card.querySelector('.name').textContent = d.name;
      card.querySelector('.pill').textContent = pill.text;
      card.querySelector('.metrics').textContent = metrics;
      const urlInput = card.querySelector('.url');
      urlInput.value = d.url;
      if (d.note) card.querySelector('.note').textContent = '⚠ ' + d.note;

      card.querySelector('.toggle-cb').onchange = (e) => save(d.name, urlInput.value, e.target.checked);
      card.querySelector('.save').onclick = () => save(d.name, urlInput.value, d.enabled);
      card.querySelector('.del').onclick = () => del(d.name);
      const retryBtn = card.querySelector('.retry');
      if (retryBtn) retryBtn.onclick = () => doRetry(d.name);
      list.appendChild(card);
    }
  }

  async function doRetry(name) {
    try { render(await api('POST', '/api/retry?name=' + encodeURIComponent(name)));
      toast('Reintentando ' + name); }
    catch (e) { toast(e.message, true); }
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
    if (document.activeElement?.classList.contains('url')) return;
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

  let recDurSel = 30;
  function setRecDur(dur) {
    recDurSel = dur;
    localStorage.setItem('ms_rec_dur', dur);
    document.querySelectorAll('.rec-dur button').forEach(b =>
      b.classList.toggle('sel', Number(b.dataset.dur) === dur));
  }

  async function toggleRec() {
    const active = $('#recToggle').dataset.active === '1';
    try {
      await api('POST', active ? '/api/record/stop' : '/api/record/start', { duration: recDurSel });
      refresh();
    } catch (e) { toast(e.message, true); }
  }

  async function browseFolder() {
    try {
      const r = await api('GET', '/api/pick-folder');
      if (r.path) { $('#clipsDir').value = r.path; localStorage.setItem('ms_clips_dir', r.path); }
    } catch (e) {
      // No es Electron: oculta el botón y deja que el usuario escriba a mano
      $('#browseBtn').style.display = 'none';
    }
  }

  async function doSaveClip() {
    const btn = $('#clipSaveBtn');
    const outputDir = $('#clipsDir').value.trim() || null;
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const r = await api('POST', '/api/record/save', { duration: recDurSel, outputDir });
      const name = r.path ? r.path.split(/[\\/]/).pop() : '';
      toast('✓ Clip guardado' + (name ? ': ' + name : ''));
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; btn.textContent = 'Guardar clip'; }
  }

  // Restaura preferencias guardadas en sesiones anteriores
  const savedDir = localStorage.getItem('ms_clips_dir');
  if (savedDir) $('#clipsDir').value = savedDir;
  const savedDur = Number(localStorage.getItem('ms_rec_dur'));
  if ([30, 60, 120].includes(savedDur)) setRecDur(savedDur);

  // ── Canvas fondo: nodos conectados ──
  (function initBg() {
    const canvas = document.getElementById('bgCanvas');
    const ctx = canvas.getContext('2d');
    const N = 18, D = 170, FPS = 15, MS = 1000 / FPS;
    let nodes = [], last = 0;
    function resize() {
      canvas.width = innerWidth; canvas.height = innerHeight;
      nodes = Array.from({length: N}, () => ({
        x: Math.random() * canvas.width, y: Math.random() * canvas.height,
        vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35,
      }));
    }
    function draw(ts) {
      requestAnimationFrame(draw);
      if (ts - last < MS) return;
      last = ts;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const light = document.documentElement.dataset.theme === 'light';
      const nodeColor = light ? 'rgba(124,92,255,.45)' : 'rgba(124,92,255,.55)';
      for (let i = 0; i < N; i++) {
        const a = nodes[i];
        a.x += a.vx; a.y += a.vy;
        if (a.x < 0 || a.x > canvas.width) a.vx *= -1;
        if (a.y < 0 || a.y > canvas.height) a.vy *= -1;
        for (let j = i + 1; j < N; j++) {
          const b = nodes[j], dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < D) {
            const alpha = (.12 * (1 - dist / D)).toFixed(3);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = 'rgba(124,92,255,' + alpha + ')'; ctx.lineWidth = .8; ctx.stroke();
          }
        }
        ctx.beginPath(); ctx.arc(a.x, a.y, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = nodeColor; ctx.fill();
      }
    }
    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(draw);
  })();

  // ── Tema claro/oscuro ──
  function toggleTheme() {
    const isLight = document.documentElement.dataset.theme === 'light';
    const next = isLight ? 'dark' : 'light';
    document.documentElement.dataset.theme = next === 'dark' ? '' : 'light';
    $('#iconSun').style.display = next === 'dark' ? '' : 'none';
    $('#iconMoon').style.display = next === 'dark' ? 'none' : '';
    localStorage.setItem('ms_theme', next);
  }
  const savedTheme = localStorage.getItem('ms_theme');
  if (savedTheme === 'light') {
    document.documentElement.dataset.theme = 'light';
    $('#iconSun').style.display = 'none';
    $('#iconMoon').style.display = '';
  }

  // ── Wordmark animation: Muxlyve → Muxly Live ──
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    (function() {
      const li = document.getElementById('wmLi');
      if (!li) return;
      function cycle() {
        li.classList.toggle('show');
        setTimeout(cycle, li.classList.contains('show')
          ? 2500 + Math.random() * 2000
          : 5000 + Math.random() * 5000);
      }
      setTimeout(cycle, 2500 + Math.random() * 1500);
    })();
  }

  function openPrefs() { $('#prefsOverlay').classList.add('open'); }
  function closePrefs() { $('#prefsOverlay').classList.remove('open'); }

  async function openLic() {
    $('#licOverlay').classList.add('open');
    $('#licEmail').textContent = '…';
    const info = await window.msLicense?.getStatus().catch(() => window.msLicense?.getInfo());
    if (!info) { $('#licEmail').textContent = '—'; return; }

    $('#licEmail').textContent = info.email || '—';

    const planLabels = { monthly: 'Mensual', annual: 'Anual', lifetime: 'Vitalicio' };
    $('#licPlan').textContent = planLabels[info.plan] || info.plan || 'Vitalicio';

    const badge = $('#licBadge');
    if (info.plan === 'lifetime') {
      badge.textContent = 'Vitalicio'; badge.className = 'lic-badge lifetime';
    } else if (info.status === 'cancelled') {
      badge.textContent = 'Cancelada'; badge.className = 'lic-badge cancelled';
    } else {
      badge.textContent = 'Activa'; badge.className = 'lic-badge active';
    }

    const renewRow = $('#licRenewRow');
    if (info.plan === 'lifetime') {
      renewRow.style.display = 'none';
    } else {
      renewRow.style.display = '';
      const ts = info.status === 'cancelled' ? info.expiresAt : info.renewsAt;
      $('#licRenewLabel').textContent = info.status === 'cancelled' ? 'Se cancela el' : 'Se renueva el';
      $('#licRenewDate').textContent = ts
        ? new Date(ts).toLocaleDateString('es', { year: 'numeric', month: 'long', day: 'numeric' })
        : '—';
    }

    $('#licDate').textContent = info.activatedAt
      ? new Date(info.activatedAt).toLocaleDateString('es', { year: 'numeric', month: 'long', day: 'numeric' })
      : '—';

    $('#licManageBtn').style.display = info.plan !== 'lifetime' ? '' : 'none';
  }
  function closeLic() { $('#licOverlay').classList.remove('open'); }
  async function releaseLic() {
    if (!confirm('¿Liberar este equipo? La app se cerrará y necesitarás tu clave para volver a activarla.')) return;
    await window.msLicense?.release();
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePrefs(); closeLic(); } });

  function toggleSidebar() {
    const sidebar = $('#sidebarCol');
    const btn = $('#sidebarToggle');
    const nowCollapsed = sidebar.classList.toggle('collapsed');
    btn.classList.toggle('panel-open', !nowCollapsed);
    localStorage.setItem('ms_sidebar_collapsed', nowCollapsed ? '1' : '0');
  }
  if (localStorage.getItem('ms_sidebar_collapsed') === '1') {
    $('#sidebarCol').classList.add('collapsed');
    $('#sidebarToggle').classList.remove('panel-open');
  }

  loadConfig();
  refresh();
  setInterval(refresh, 2000); // refleja estado en vivo y reenvíos activos
</script>
</body>
</html>`;
