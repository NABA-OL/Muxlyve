// Desarrollado por BlacKraken Solutions (NABA-OL)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { loadAll, saveAll, isValidUrl, isPlayable } from './destinations.js';
import { isLive, relayInfo, uptimeSeconds, applyChange, stopByName, retry, recorderInfo, startRecording, stopRecording, saveClip, listRecentClips } from './relays.js';
import { ingestInfo, audioBus } from './monitor.js';
import { chatBus, getHistory as getChatHistory } from './chat.js';
import { getViewerCounts } from './viewers.js';
import { applyChatMode as applyChatModeBackend, sendChatMessage as sendChatMessageBackend, pinChatMessage as pinChatMessageBackend } from './chatmod.js';
import { tMap } from './i18n.js';
import { getOrCreatePanelToken, isLoopback } from './panelAuth.js';

// Orden por longitud descendente: si una key corta (" disponible") se reemplaza antes que
// una key larga que la contiene ("No disponible en esta versión."), la larga nunca vuelve a
// matchear y queda mezclada en dos idiomas. Ordenar así lo evita sin depender de mantener
// tMap en un orden particular a mano — se auto-corrige aunque se agreguen keys nuevas.
const TMAP_KEYS_BY_LENGTH = Object.keys(tMap).sort((a, b) => b.length - a.length);

function translateHtml(html) {
  if (process.env.APP_LANG === 'es' || !process.env.APP_LANG) return html;
  let translated = html;
  for (const es of TMAP_KEYS_BY_LENGTH) {
    translated = translated.split(es).join(tMap[es]);
  }
  return translated;
}

function t(text) {
  if (process.env.APP_LANG !== 'es') return tMap[text] || text;
  return text;
}

const MAX_NAME = 40;
const MAX_URL = 500;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
// Assets estáticos auto-hospedados (sin CDN): cargados una vez al arrancar.
const FLV_JS = readFileSync(path.join(PUBLIC, 'flv.min.js'));
const LOGO_SVG       = readFileSync(path.join(PUBLIC, 'logo-muxlyve.svg'));
const LOGO_SVG_LIGHT = readFileSync(path.join(PUBLIC, 'logo-muxlyve-light.svg'));
const ICON_SVG       = readFileSync(path.join(PUBLIC, 'icon-muxlyve.svg'));
const CONNECTIONS_SVG = readFileSync(path.join(PUBLIC, 'connections.svg'));
const VIDEO_OFF_SVG   = readFileSync(path.join(PUBLIC, 'video-off.svg'));
const CHAT_SVG        = readFileSync(path.join(PUBLIC, 'chat.svg'));

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
  return { live: isLive(), uptime: uptimeSeconds(), destinations, recorder: recorderInfo(), ingest: ingestInfo() };
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
  if (!name) return { error: t('El nombre es obligatorio.') };
  if (name.length > MAX_NAME) return { error: t('Nombre máximo ') + MAX_NAME + t(' caracteres.') };
  if (url.length > MAX_URL) return { error: t('URL máxima ') + MAX_URL + t(' caracteres.') };
  // Solo exigimos URL válida si se quiere habilitar (TikTok puede quedar deshabilitado con placeholder).
  if (enabled && !isValidUrl(url)) {
    return { error: t('Para activar, la URL debe empezar por rtmp://, rtmps:// o srt:// y no ser un placeholder.') };
  }
  return { dest: { name, url, enabled } };
}

let publicIpCache = null; // { ip, at } — evita golpear el servicio externo en cada carga del panel
const PUBLIC_IP_TTL_MS = 5 * 60 * 1000;

async function fetchPublicIp() {
  if (publicIpCache && Date.now() - publicIpCache.at < PUBLIC_IP_TTL_MS) return publicIpCache.ip;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    const { ip } = await r.json();
    publicIpCache = { ip, at: Date.now() };
    return ip;
  } catch {
    return publicIpCache?.ip || null; // sirve la última conocida si el servicio falla
  } finally {
    clearTimeout(timeout);
  }
}

async function handleApi(req, res, url) {
  // GET /api/state
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, buildState());
  }

  // GET /api/public-ip -> IP pública (para exponer el ingest fuera de la red local vía port forwarding)
  if (req.method === 'GET' && url.pathname === '/api/public-ip') {
    const ip = await fetchPublicIp();
    return json(res, 200, { ip });
  }

  // GET /api/audio -> SSE: niveles de audio L/R en tiempo real (~16 Hz) para el VU meter.
  if (req.method === 'GET' && url.pathname === '/api/audio') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const onLevel = (lvl) => res.write(`data: ${JSON.stringify(lvl)}\n\n`);
    audioBus.on('level', onLevel);
    req.on('close', () => audioBus.off('level', onLevel));
    return;
  }

  // GET /api/chat -> SSE: mensajes de chat unificados (Twitch por ahora).
  if (req.method === 'GET' && url.pathname === '/api/chat') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const msg of getChatHistory()) res.write(`data: ${JSON.stringify(msg)}\n\n`);
    const onMessage = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
    chatBus.on('message', onMessage);
    req.on('close', () => chatBus.off('message', onMessage));
    return;
  }

  // GET /api/debug-log -> SSE de debugBus (ver DEBUG_LOG_ROUTES arriba) — PANEL_HTML lo
  // vuelca a console.log/error para verlo en DevTools, ya que este proceso Node no
  // comparte consola con el renderer de Electron.
  if (req.method === 'GET' && url.pathname === '/api/debug-log') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const onLog = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
    debugBus.on('log', onLog);
    req.on('close', () => debugBus.off('log', onLog));
    return;
  }

  // GET /api/viewers -> { twitch: {count, live}, kick: {...} } — último valor sondeado
  // por electron/oauth.js. Lo consultan tanto el panel principal como el popout de chat.
  if (req.method === 'GET' && url.pathname === '/api/viewers') {
    return json(res, 200, getViewerCounts());
  }

  // POST /api/chat-mode -> modo lento / solo emotes (solo Twitch, ver src/chatmod.js).
  // Por HTTP y no IPC para que el popout de chat también lo pueda usar (no tiene preload).
  if (req.method === 'POST' && url.pathname === '/api/chat-mode') {
    const body = await readBody(req);
    const result = await applyChatModeBackend({
      emoteOnly: !!body.emoteOnly,
      subscriberOnly: !!body.subscriberOnly,
      slowSeconds: Number(body.slowSeconds) || 0,
    });
    return json(res, 200, result);
  }

  // POST /api/chat-send -> publica un mensaje como el streamer en Twitch + Kick (chatmod.js).
  if (req.method === 'POST' && url.pathname === '/api/chat-send') {
    const body = await readBody(req);
    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) return json(res, 400, { error: t('Mensaje vacío.') });
    const result = await sendChatMessageBackend(text);
    return json(res, 200, result);
  }

  // POST /api/chat-pin -> fija un mensaje (solo Twitch, ver src/chatmod.js).
  if (req.method === 'POST' && url.pathname === '/api/chat-pin') {
    const body = await readBody(req);
    const messageId = String(body.messageId || '').trim();
    if (!messageId) return json(res, 400, { error: t('Falta el id del mensaje.') });
    const result = await pinChatMessageBackend(messageId);
    return json(res, 200, result);
  }

  // POST /api/destinations  -> upsert por nombre (crear, editar URL, toggle ON/OFF, clave TikTok)
  if (req.method === 'POST' && url.pathname === '/api/destinations') {
    let input;
    try { input = await readBody(req); }
    catch (err) {
      debugLog('error', `POST /api/destinations -> 400 leyendo el body: ${err.message}`);
      return json(res, 400, { error: err.message });
    }
    debugLog('log', `POST /api/destinations body recibido: ${JSON.stringify(input)}`);
    const { error, dest } = validateDestination(input);
    if (error) {
      debugLog('error', `POST /api/destinations -> 400 validateDestination: ${error}`);
      return json(res, 400, { error });
    }

    const list = loadAll();
    const idx = list.findIndex((d) => d.name === dest.name);
    const next = idx >= 0
      ? list.map((d, i) => (i === idx ? { ...d, url: dest.url, enabled: dest.enabled } : d))
      : [...list, dest];
    saveAll(next);
    applyChange(dest); // arranca/para el relay en caliente si hay emisión
    debugLog('log', `POST /api/destinations -> 200, "${dest.name}" enabled=${dest.enabled}`);
    return json(res, 200, buildState());
  }

  // POST /api/retry?name=X  -> reintento manual de un destino 'failed'
  if (req.method === 'POST' && url.pathname === '/api/retry') {
    const name = url.searchParams.get('name');
    const dest = loadAll().find((d) => d.name === name);
    if (!dest) return json(res, 404, { error: t('Destino no encontrado.') });
    retry(dest);
    return json(res, 200, buildState());
  }

  // DELETE /api/destinations?name=X
  if (req.method === 'DELETE' && url.pathname === '/api/destinations') {
    const name = url.searchParams.get('name');
    if (!name) return json(res, 400, { error: t('Falta el parámetro name.') });
    stopByName(name);
    saveAll(loadAll().filter((d) => d.name !== name));
    return json(res, 200, buildState());
  }

  // POST /api/record/start  { duration?: 30|60|120 } — sin duration, usa la última
  // configurada (recorderInfo().duration): así un cliente que no conoce la preferencia
  // del usuario (ej. el plugin de Stream Deck) prende el buffer con la misma duración
  // que ya está seleccionada en Preferencias, sin tener que replicar ese ajuste aparte.
  if (req.method === 'POST' && url.pathname === '/api/record/start') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const dur = [30, 60, 120].includes(Number(input.duration)) ? Number(input.duration) : recorderInfo().duration;
    if (!isLive()) return json(res, 409, { error: t('No hay transmisión activa.') });
    startRecording(dur);
    return json(res, 200, buildState());
  }

  // POST /api/record/stop
  if (req.method === 'POST' && url.pathname === '/api/record/stop') {
    stopRecording();
    return json(res, 200, buildState());
  }

  // POST /api/record/save  { duration?: 30|60|120, outputDir?: string } — sin duration,
  // usa la del buffer activo (recorderInfo().duration), mismo criterio que /api/record/start.
  if (req.method === 'POST' && url.pathname === '/api/record/save') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const dur = [30, 60, 120].includes(Number(input.duration)) ? Number(input.duration) : recorderInfo().duration;
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
      return json(res, 501, { error: t('Selector solo disponible en la app de escritorio.') });
    }
  }

  // GET /api/clips?dir=  → últimos clips guardados en el folder configurado (o el
  // default si no hay uno elegido) — mismo folder que usa /api/record/save.
  if (req.method === 'GET' && url.pathname === '/api/clips') {
    const outputDir = url.searchParams.get('dir') || null;
    try {
      const { dir, files } = listRecentClips(outputDir);
      return json(res, 200, { dir, files });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/clips/open  { path, reveal? }  → abre una carpeta, o revela un archivo
  // puntual en el explorador nativo (solo Electron).
  if (req.method === 'POST' && url.pathname === '/api/clips/open') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!input.path) return json(res, 400, { error: 'Falta path.' });
    try {
      const { shell } = await import('electron');
      if (input.reveal) {
        shell.showItemInFolder(input.path);
      } else {
        const err = await shell.openPath(input.path);
        if (err) return json(res, 500, { error: err });
      }
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 501, { error: t('Selector solo disponible en la app de escritorio.') });
    }
  }

  return json(res, 404, { error: t('No encontrado.') });
}

// Rutas que siguen abiertas en LAN sin token aunque ALLOW_LAN_PANEL esté activo: el
// overlay de chat para OBS/Streamlabs se pega por URL en una fuente de Navegador, que no
// puede mandar headers — exigirle token rompería la razón de ser de la función. No exponen
// nada sensible (mensajes de chat ya públicos en Twitch/Kick, sin claves ni control).
const PUBLIC_LAN_PATHS = new Set(['/chat-overlay', '/api/chat']);

// Debug del LAN pairing (Stream Deck, etc.) — panel.js corre en el proceso Node del motor,
// no comparte consola con el renderer de Electron, así que console.log acá solo se ve en
// la terminal (o ni eso, en la app empaquetada sin terminal). Este bus reemite cada línea
// por SSE (/api/debug-log) para que PANEL_HTML la vuelque a su propio console.log/error —
// esa sí es la consola de DevTools real que el usuario puede abrir. Acotado a propósito a
// las rutas de abajo, no es logging general.
const debugBus = new EventEmitter();
const DEBUG_LOG_ROUTES = new Set(['/api/state', '/api/destinations']);
// Silencio total si ALLOW_LAN_PANEL está apagado (default para casi todos): sin esto,
// cada poll de /api/state (~cada 2s, de TODOS los usuarios) satura el buffer de 500
// líneas que alimenta "Reportar un problema" (ver electron/logbuffer.js) y empuja afuera
// lo útil. El check vive acá adentro para no tener que acordarse en cada call site.
function debugLog(level, line) {
  if (process.env.ALLOW_LAN_PANEL !== 'true') return;
  (level === 'error' ? console.error : console.log)(`[panel-debug] ${line}`);
  debugBus.emit('log', { level, line, at: Date.now() });
}

// Sin esto, cada poll normal de /api/state (~cada 2s, por cliente) reescribe el buffer de
// 500 líneas de "Reportar un problema" con puro ruido de "todo bien" — para cuando alguien
// manda un reporte por otra cosa, lo único que queda son estas líneas. Por eso: un éxito
// se loguea una vez cada HEARTBEAT_MS por (IP + ruta) salvo que la vez anterior haya sido
// error, en cuyo caso se loguea de una como "recuperado" — errores SIEMPRE se loguean, sin
// throttle, porque son justo lo que hace falta ver.
const HEARTBEAT_MS = 10 * 60 * 1000;
const lastLogState = new Map(); // key (ip|method|path) -> { at, error }
function debugLogSmart(key, isError, line) {
  const prev = lastLogState.get(key);
  const now = Date.now();
  if (isError) {
    lastLogState.set(key, { at: now, error: true });
    debugLog('error', line);
    return;
  }
  const recovering = prev?.error;
  const dueHeartbeat = !prev || (now - prev.at >= HEARTBEAT_MS);
  lastLogState.set(key, { at: now, error: false });
  if (recovering) debugLog('log', 'RECUPERADO — ' + line);
  else if (dueHeartbeat) debugLog('log', line);
}

export function startPanel(port, config = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    try {
      // debugLog() ya se auto-silencia si ALLOW_LAN_PANEL está apagado — acá solo se
      // acota a las 2 rutas que hace falta depurar (ver DEBUG_LOG_ROUTES). Éxitos van
      // por debugLogSmart (throttled, ver arriba) — errores siempre se loguean de una.
      const dbg = DEBUG_LOG_ROUTES.has(url.pathname);
      const dbgKey = `${req.socket.remoteAddress}|${req.method}|${url.pathname}`;
      const dbgId = `${req.method} ${url.pathname} desde ${req.socket.remoteAddress} (Authorization: ${req.headers.authorization ? 'presente' : 'ausente'})`;
      // Fuera de loopback, con LAN habilitada: todo lo que no esté en el allowlist de
      // arriba exige el token compartido (claves RTMP, control de destinos, envío de
      // chat como el streamer, etc. — nada de eso tiene otra protección).
      // OJO: este bloque es UNO SOLO, corre para cualquier req.method antes de que se
      // rutee por método/path más abajo — no hay middleware distinto entre GET y POST,
      // ambos pasan por acá exactamente igual.
      if (process.env.ALLOW_LAN_PANEL === 'true' && !isLoopback(req) && !PUBLIC_LAN_PATHS.has(url.pathname)) {
        const expected = `Bearer ${getOrCreatePanelToken()}`;
        const got = req.headers.authorization;
        if (got !== expected) {
          const reason = !got ? 'token ausente (sin header Authorization)' : 'token presente pero no coincide con el esperado';
          if (dbg) debugLogSmart(dbgKey, true, `AUTH RECHAZADO ${dbgId} — ${reason}`);
          return json(res, 401, { error: t('No autorizado — falta o es inválido el token del panel.') });
        }
        if (dbg) debugLogSmart(dbgKey, false, `AUTH OK ${dbgId} — token válido, no-loopback`);
      } else if (dbg) {
        const why = process.env.ALLOW_LAN_PANEL !== 'true'
          ? 'ALLOW_LAN_PANEL desactivado, no se exige token'
          : isLoopback(req)
            ? 'request desde loopback, no se exige token'
            : 'ruta en el allowlist público, no se exige token';
        debugLogSmart(dbgKey, false, `AUTH OMITIDO ${dbgId} — ${why}`);
      }
      // Config del ingest (URL/clave/preview) — estática, el panel la pide una vez.
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return json(res, 200, {
          rtmpUrl: config.rtmpUrl || '',
          lanRtmpUrl: config.lanRtmpUrl || '',
          lanIp: config.lanIp || null,
          rtmpPort: config.rtmpPort || null,
          streamKey: config.streamKey || '',
          flvUrl: config.flvUrl || '',
          version: config.version || '0.0.0',
          panelToken: process.env.ALLOW_LAN_PANEL === 'true' ? getOrCreatePanelToken() : null,
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
      if (url.pathname === '/connections.svg' || url.pathname === '/video-off.svg' || url.pathname === '/chat.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
        if (url.pathname === '/connections.svg') return res.end(CONNECTIONS_SVG);
        if (url.pathname === '/video-off.svg') return res.end(VIDEO_OFF_SVG);
        return res.end(CHAT_SVG);
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(translateHtml(PANEL_HTML));
      }
      if (url.pathname === '/chat-window') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(translateHtml(CHAT_WINDOW_HTML));
      }
      // Fuente de navegador para OBS — mismo feed SSE que /chat-window, sin chrome de
      // ventana (estrellas, header, menú de moderación, caja de envío): solo mensajes,
      // fondo transparente para componer directo sobre la escena.
      if (url.pathname === '/chat-overlay') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(translateHtml(CHAT_OVERLAY_HTML));
      }
      // GET /oauth/:platform — Electron intercepta el redirect antes de que llegue aquí
      // (will-navigate/will-redirect); esto es solo fallback visual si algo se cuela.
      if (req.method === 'GET' && url.pathname.startsWith('/oauth/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(translateHtml('<!doctype html><html><head><meta charset="utf-8"><title>Conectando…</title></head><body style="font-family:system-ui;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Autorización recibida — puedes cerrar esta ventana.</p></body></html>'));
      }
      res.writeHead(404).end('No encontrado');
    } catch (err) {
      console.error('[panel] error:', err.message);
      json(res, 500, { error: t('Error interno del panel.') });
    }
  });
  // Por defecto solo localhost — la API no tiene auth (claves RTMP en texto plano,
  // envío/fijado de chat como el streamer, prender/apagar destinos), así que exponerla
  // es opt-in explícito. ALLOW_LAN_PANEL=true la abre a la LAN (0.0.0.0) para el chat
  // overlay y el plugin de Stream Deck desde otra máquina — bajo cuenta y riesgo del
  // usuario, cualquiera en esa red la puede tocar sin restricción adicional.
  const bindHost = process.env.ALLOW_LAN_PANEL === 'true' ? '0.0.0.0' : '127.0.0.1';
  server.on('error', (err) => {
    console.error(`[panel] ERROR al iniciar en puerto ${port}:`, err.code, err.message);
  });
  server.listen(port, bindHost, () => {
    console.log(` Panel web:    http://localhost:${port}` + (bindHost === '0.0.0.0' ? ' (también accesible desde tu red local)' : ''));
  });
  return server;
}

export const PANEL_HTML = /* html */ `<!doctype html>
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
    --side-bar-w: 56px;
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
    --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
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
  /* Grid de 3 columnas (no flex+space-between): logo | status | placeholder vacío.
     Los dos extremos son 1fr — reparten el sobrante en partes iguales, así el status
     del medio queda centrado de verdad sin importar cuánto mida el logo. Con solo 2
     hijos y space-between, el status se va pegado al borde derecho (justo el bug que
     apareció al sacar los botones que antes ocupaban esa 3ra columna). */
  header { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
    gap: 1rem; padding: 1rem 1.5rem; border-bottom: 1px solid var(--border);
    background: var(--surface); position: sticky; top: 0; z-index: 5;
    height: var(--header-h); -webkit-app-region: drag; }
  .logo-wrap { justify-self: start; }
  .status { justify-self: center; }
  header button, header a, header input { -webkit-app-region: no-drag; }
  /* Barra de título fundida (hiddenInset en Mac deja los 3 botones a la izquierda;
     titleBarOverlay en Windows deja los suyos a la derecha) — espacio para que no se
     encimen con el logo o los botones propios de la app. El padding-right base (barra
     lateral nueva) va aparte más abajo; en Windows los controles nativos ocupan más
     ancho que la barra sola, así que esa regla más específica manda igual. */
  body.platform-darwin header { padding-left: 96px; }
  body.platform-win32 header { padding-right: 150px; }
  /* Barra lateral fija a la derecha (ajustes/conexiones/chat) — el header y el
     contenido principal dejan este ancho libre para que no quede nada debajo. */
  header { padding-right: var(--side-bar-w); }
  main { margin-right: var(--side-bar-w); }
  .logo-wrap { display: flex; align-items: center; gap: .55rem; flex-shrink: 0; text-decoration: none; }
  .logo-icon { height: 32px; width: 32px; object-fit: contain; }
  .wordmark { font-size: 1.1rem; font-weight: 700; letter-spacing: -.03em; cursor: default; user-select: none; color: var(--text); }
  .wm-ve { color: var(--accent); }
  .wm-li {
    display: inline-block; overflow: hidden; max-width: 0; opacity: 0;
    transition: max-width .7s cubic-bezier(.4,0,.2,1), opacity .55s var(--ease-out);
    vertical-align: bottom;
  }
  .wm-li { color: var(--accent); }
  .wm-li.show { max-width: 2.4ch; opacity: 1; }
  @media (prefers-reduced-motion: reduce) { .wm-li { transition: none; } }
  .status { display: flex; align-items: center; gap: .5rem; font-size: .85rem; color: var(--muted); min-width: 0; }
  .status .uptime { font-variant-numeric: tabular-nums; color: var(--text); flex-shrink: 0; }
  .stream-title-display { color: var(--text); overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; min-width: 0; padding-left: .5rem; border-left: 1px solid var(--border); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--off);
    box-shadow: 0 0 0 0 transparent; transition: background .3s var(--ease-out), box-shadow .3s var(--ease-out); }
  .dot.on {
    background: var(--live);
    box-shadow: 0 0 0 4px rgba(46,160,67,.18);
    animation: live-pulse .5s var(--ease-out);
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.on { animation: none; }
  }
  @keyframes live-pulse {
    0%   { transform: scale(1); }
    60%  { transform: scale(1.35); }
    100% { transform: scale(1); }
  }
  /* Barra vertical fija a la derecha — reemplaza los 3 botones que antes vivían en el
     header. Mismo color que la barra superior (surface), para que se vea como una sola
     pieza de UI. El grupo de arriba arranca debajo de donde iría el botón de cerrar
     nativo (--header-h) — en Windows ahí mismo dibuja sus controles el titleBarOverlay,
     así que dejar ese espacio vacío evita que se encimen. Ajustes queda solo, pegado
     a la esquina inferior. */
  /* Arranca justo debajo del header (top: var(--header-h)), no en top:0 — así el header
     queda de punta a punta arriba, sin que esta barra se le monte encima ni se crucen
     bordes/z-index entre las dos. */
  /* Sin borde ni esquina redondeada propia a propósito — mismo fondo que el header,
     misma línea divisoria (el border-bottom del header sigue derecho por encima) para
     que se vea como una sola pieza fundida, no como un panel aparte pegado al lado. */
  .side-actions { position: fixed; top: var(--header-h); right: 0; bottom: 0; width: var(--side-bar-w);
    background: var(--surface);
    display: flex; flex-direction: column; align-items: center; z-index: 4;
    -webkit-app-region: drag; }
  .side-actions button { -webkit-app-region: no-drag; }
  .side-actions-top { display: flex; flex-direction: column; gap: .35rem; padding-top: 1rem; }
  .side-actions-bottom { margin-top: auto; padding-bottom: .85rem; }
  /* Solo ícono, look tipo rail (WhatsApp Mac) — sin caja/borde por botón, un resaltado
     redondeado sutil en hover/activo alcanza. */
  .side-actions .sidebar-toggle-btn { background: transparent; border: none;
    width: 38px; height: 38px; border-radius: 10px; color: var(--muted);
    padding: 0; justify-content: center; position: relative; }
  .side-actions .sidebar-toggle-btn:hover { background: var(--surface-2); color: var(--text); }
  .side-actions .sidebar-toggle-btn.panel-open { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
  /* Aviso no invasivo de actualización — ícono discreto arriba de Ajustes, solo visible
     si hay versión nueva (ver openUpdaterModal/pendingUpdatePayload). Nada de modal al
     abrir la app: el usuario decide cuándo verlo, con clic. */
  #updateBtn { color: var(--accent); }
  #updateBtn:hover { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  #updateBtn .upd-dot { position: absolute; top: 6px; right: 7px; width: 7px; height: 7px;
    border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--surface); }

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
  /* SVG externo de un solo color (fill sólido, sin currentColor propio) pintado vía
     máscara con background-color: currentColor — así hereda el color del botón (incluida
     la transición de hover) igual que los íconos inline con stroke="currentColor". */
  .icon-mask { display: inline-block; background-color: currentColor;
    -webkit-mask-size: contain; mask-size: contain;
    -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
    -webkit-mask-position: center; mask-position: center; }
  .icon-connections { width: 16px; height: 16px;
    -webkit-mask-image: url(/connections.svg); mask-image: url(/connections.svg); }
  .icon-chat { width: 16px; height: 16px;
    -webkit-mask-image: url(/chat.svg); mask-image: url(/chat.svg); }

  /* ── Toggle switch ── */
  .switch { position: relative; display: inline-block; width: 42px; height: 24px; flex-shrink: 0; }
  .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
  .switch .thumb {
    position: absolute; inset: 0; background: var(--off); border-radius: 12px;
    cursor: pointer; transition: background .2s var(--ease-out);
  }
  .switch .thumb::before {
    content: ''; position: absolute; width: 18px; height: 18px;
    left: 3px; top: 3px; background: #fff; border-radius: 50%;
    transition: transform .2s var(--ease-out);
  }
  .switch input:checked ~ .thumb { background: var(--accent); }
  .switch input:checked ~ .thumb::before { transform: translateX(18px); }

  /* ── Modal de Preferencias ── */
  .prefs-overlay {
    display: none;
    position: fixed; inset: 0;
    background: rgba(0,0,0,0);
    z-index: 50;
    align-items: center; justify-content: center;
    backdrop-filter: blur(0px);
    opacity: 0;
    transition:
      opacity 180ms var(--ease-out),
      background 180ms var(--ease-out),
      backdrop-filter 180ms var(--ease-out),
      display 180ms allow-discrete;
  }
  .prefs-overlay.open {
    display: flex;
    opacity: 1;
    background: rgba(0,0,0,.5);
    backdrop-filter: blur(3px);
    @starting-style {
      opacity: 0;
      background: rgba(0,0,0,0);
      backdrop-filter: blur(0px);
    }
  }
  .prefs-modal {
    background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
    padding: 1.5rem; width: 420px; max-width: 90vw;
    box-shadow: 0 24px 64px rgba(0,0,0,.5);
    transform: scale(.96);
    opacity: 0;
    transition: transform 180ms var(--ease-out), opacity 180ms var(--ease-out);
  }
  .prefs-overlay.open .prefs-modal {
    transform: scale(1);
    opacity: 1;
  }
  .prefs-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.25rem; }
  .prefs-head h2 { margin: 0; font-size: 1.05rem; font-weight: 600; }
  .prefs-close { background: transparent; color: var(--muted); border: 1px solid transparent;
    font-size: 1rem; padding: .2rem .45rem; border-radius: 6px; }
  .prefs-close:hover { color: var(--text); background: var(--surface-2); }
  .prefs-modal-wide { width: 720px; }
  .upd-progress-track { height: 8px; border-radius: 99px; background: var(--surface-2); overflow: hidden; margin: .25rem 0 .75rem; }
  .upd-progress-fill { height: 100%; background: var(--accent); border-radius: 99px; width: 0%; transition: width 160ms linear; }
  .upd-progress-text { font-size: .8rem; color: var(--muted); margin: 0 0 .75rem; }
  .prefs-layout { display: flex; gap: 1.5rem; align-items: flex-start; }
  .prefs-nav { width: 190px; flex-shrink: 0; display: flex; flex-direction: column; gap: .15rem; }
  .prefs-nav-item { display: flex; align-items: center; gap: .55rem; width: 100%;
    padding: .6rem .7rem; border-radius: 9px; background: transparent; border: none;
    color: var(--muted); font-size: .85rem; font-weight: 600; text-align: left;
    transition: background .15s var(--ease-out), color .15s var(--ease-out); }
  .prefs-nav-item svg:first-child { flex-shrink: 0; }
  .prefs-nav-item span { flex: 1; }
  .prefs-nav-chevron { flex-shrink: 0; opacity: 0; transition: opacity .15s var(--ease-out); }
  .prefs-nav-item:hover { background: var(--surface-2); color: var(--text); }
  .prefs-nav-item.active { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
  .prefs-nav-item.active .prefs-nav-chevron { opacity: 1; }
  /* Grid con todos los paneles apilados en la misma celda (1/1): el alto de la fila
     queda fijado por el más alto de los 4 (Sistema, normalmente) aunque esté oculto —
     visibility:hidden sigue contando para el layout, a diferencia de display:none. Así
     el modal no salta de tamaño al cambiar de sección, solo cambia el contenido visible. */
  .prefs-panels { flex: 1; min-width: 0; max-height: 60vh; overflow-y: auto; padding-right: .25rem;
    display: grid; }
  .prefs-panel { grid-area: 1 / 1; opacity: 0; visibility: hidden; pointer-events: none; }
  .prefs-panel.active { opacity: 1; visibility: visible; pointer-events: auto;
    animation: prefsPanelFade .18s var(--ease-out); }
  @keyframes prefsPanelFade { from { opacity: 0; } to { opacity: 1; } }
  .pref-row { display: flex; align-items: center; justify-content: space-between;
    padding: .5rem 0; border-bottom: 1px solid var(--border); }
  .pref-row:last-child { border-bottom: none; }
  .pref-row label:first-child { font-size: .85rem; color: var(--text); }
  .pref-row .pref-desc { font-size: .72rem; color: var(--muted); margin-top: .15rem; }
  .sys-toggle { position: relative; display: inline-block; width: 36px; height: 20px; flex-shrink: 0; }
  .sys-toggle input { opacity: 0; width: 0; height: 0; }
  .sys-toggle-track { position: absolute; inset: 0; background: var(--surface-2);
    border-radius: 20px; border: 1px solid var(--border); transition: background .2s var(--ease-out); cursor: pointer; }
  .sys-toggle input:checked + .sys-toggle-track { background: var(--accent); border-color: var(--accent); }
  .sys-toggle-track::after { content: ''; position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px; border-radius: 50%; background: #fff;
    transition: transform .2s var(--ease-out); }
  .sys-toggle input:checked + .sys-toggle-track::after { transform: translateX(16px); }
  .lang-opt-btn { padding: .3rem .65rem; font-size: .78rem; border-radius: 7px;
    border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer;
    transition: background .2s var(--ease-out), color .2s var(--ease-out), border-color .2s var(--ease-out); }
  .lang-opt-btn:hover { color: var(--text); }
  .lang-opt-btn.sel { background: var(--accent); border-color: var(--accent); color: #fff; }

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

  /* ── Modal Acerca de ── */
  .about-modal { width: 340px; text-align: center; }
  .about-logo { font-size: 2rem; font-weight: 800; letter-spacing: -.03em;
    background: linear-gradient(135deg, #7c5cff, #a78bfa); -webkit-background-clip: text;
    -webkit-text-fill-color: transparent; background-clip: text; margin: .5rem 0 .25rem; }
  .about-version { font-size: .75rem; color: var(--muted); margin-bottom: 1.25rem; }
  .about-dev { font-size: .9rem; color: var(--text); margin-bottom: .25rem; }
  .about-copy { font-size: .75rem; color: var(--muted); margin-bottom: 1.25rem; line-height: 1.5; }
  .about-link { font-size: .8rem; color: var(--accent); text-decoration: none; }
  .about-link:hover { text-decoration: underline; }
  .about-divider { height: 1px; background: var(--border); margin: 1rem 0; }
  .about-btn-row { display: flex; gap: .5rem; margin-top: 1rem; }
  .about-close-btn { flex: 1; padding: .5rem; background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text); border-radius: 8px; font-size: .85rem; cursor: pointer; }
  .about-close-btn:hover { background: var(--border); }

  /* ── Barra de ingest: stats + VU meter ── */
  .ingest-bar { display: flex; align-items: center; gap: .75rem; margin-top: .6rem;
    padding: .5rem .65rem; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; }
  .ingest-pill { font-size: .72rem; font-weight: 600; color: var(--muted); font-family: ui-monospace, monospace;
    white-space: nowrap; letter-spacing: .02em; }
  .vu { flex: 1; display: flex; flex-direction: column; gap: 3px; }
  .vu-ch { height: 7px; background: var(--bg); border-radius: 4px; overflow: hidden; }
  .vu-fill { display: block; height: 100%; width: 0%;
    background: linear-gradient(90deg, #2ea043 0%, #2ea043 65%, #d29922 82%, #f85149 100%);
    border-radius: 4px; transition: width 80ms linear; }

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
  .rec-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
  .rec-toggle-label { font-size: .85rem; color: var(--text); font-weight: 600; }
  .rec-toggle-row .rec-status { margin-top: .15rem; }
  .recent-clips { margin-top: .85rem; padding-top: .75rem; border-top: 1px solid var(--border); }
  .recent-clips-head { font-size: .72rem; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: .06em; margin-bottom: .5rem; }
  .recent-clip-item { display: flex; align-items: center; gap: .55rem; padding: .4rem .5rem;
    border-radius: 8px; cursor: pointer; transition: background .15s var(--ease-out); }
  .recent-clip-item:hover { background: var(--surface-2); }
  .recent-clip-item svg { flex-shrink: 0; color: var(--muted); }
  .recent-clip-info { flex: 1; min-width: 0; }
  .recent-clip-name { font-size: .8rem; color: var(--text); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .recent-clip-meta { font-size: .7rem; color: var(--muted); }

  /* ── Preview ── */
  .preview { margin-bottom: 1rem; }
  /* Registrada como <color> para que @keyframes la interpole en vez de saltar entre valores. */
  @property --glow-video { syntax: '<color>'; inherits: false; initial-value: #7c5cff; }
  .video-wrap { position: relative; background: #000;
    border: 1px solid color-mix(in srgb, var(--glow-video) 45%, var(--border));
    border-radius: 12px; overflow: hidden; aspect-ratio: 16 / 9;
    box-shadow:
      0 8px 25px -8px color-mix(in srgb, var(--glow-video) 55%, transparent),
      inset 0 0 16px -8px color-mix(in srgb, var(--glow-video) 50%, transparent);
    animation: videoGlowOffline 4s ease-in-out infinite; }
  /* Sin señal: rojo↔naranja, ciclo más corto (llama la atención). En vivo: morado↔azul de marca. */
  @keyframes videoGlowOffline {
    0%, 100% { --glow-video: #f85149; }
    50% { --glow-video: #f0a23a; }
  }
  @keyframes videoGlowLive {
    0%, 100% { --glow-video: #7c5cff; }
    50% { --glow-video: #4da3ff; }
  }
  .video-wrap.live { animation: videoGlowLive 6s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) {
    .video-wrap { animation: none; --glow-video: #f85149; }
    .video-wrap.live { animation: none; --glow-video: #7c5cff; }
  }
  .video-wrap video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .video-ph { position: absolute; inset: 0; display: flex; flex-direction: column; gap: .65rem;
    align-items: center; justify-content: center; color: var(--muted); font-size: .88rem;
    text-align: center; padding: 1rem; }
  /* El fondo del preview es negro fijo (#000) sin importar el tema — el ícono va claro
     siempre, no var(--muted)/var(--text) que cambian con tema claro/oscuro. */
  .icon-video-off { width: 40px; height: 40px; background-color: #e6edf3;
    -webkit-mask-image: url(/video-off.svg); mask-image: url(/video-off.svg);
    animation: videoOffBlink 3s ease-in-out infinite; }
  @keyframes videoOffBlink { 0%, 100% { opacity: .3; } 50% { opacity: .9; } }
  @media (prefers-reduced-motion: reduce) {
    .icon-video-off { animation: none; opacity: .6; }
  }
  .conn { display: flex; flex-direction: column; gap: .5rem; margin-top: .75rem; }
  .conn .field { background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: .6rem .75rem; box-shadow: 0 1px 2px rgba(0,0,0,.15);
    transition: border-color .15s var(--ease-out); }
  .conn .field:hover { border-color: var(--muted); }
  .copyrow { display: flex; gap: .4rem; align-items: center; }
  .copyrow input[type="text"] { flex: 1; min-width: 0; }
  .browse-btn { background: var(--accent); color: #fff; border: none; border-radius: 6px;
    padding: .4rem .65rem; font-size: .85rem; flex-shrink: 0; cursor: pointer; }
  .browse-btn:hover { filter: brightness(1.1); }
  .danger-btn { background: transparent; color: var(--danger); border: 1px solid var(--danger);
    border-radius: 6px; padding: .4rem .85rem; cursor: pointer; }
  .danger-btn:hover { background: rgba(248,81,73,.1); }

  /* ── Chat unificado ── */
  .chat-box { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column;
    gap: .3rem; padding-right: .2rem; }
  .chat-row { font-size: .8rem; line-height: 1.35; display: flex; gap: .35rem; align-items: flex-start; }
  .chat-pin-btn { margin-left: auto; flex-shrink: 0; background: transparent; border: none;
    color: var(--muted); cursor: pointer; opacity: 0; transition: opacity .15s var(--ease-out);
    padding: 0 2px; display: flex; align-items: center; }
  .chat-row:hover .chat-pin-btn { opacity: 1; }
  .chat-pin-btn:hover { color: var(--accent); }
  .chat-pin-btn:disabled { opacity: .4; cursor: default; }
  .chat-row .chat-icon { flex-shrink: 0; margin-top: .1rem; }
  .chat-emote { height: 1.4em; width: auto; vertical-align: middle; display: inline-block; }
  .chat-empty { color: var(--muted); font-size: .78rem; padding: .3rem 0; }
  .chat-panel { display: flex; flex-direction: column; height: 100%; }
  .chat-panel-head { display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0; margin-bottom: .1rem; }
  .chat-panel-title { font-weight: 600; font-size: .95rem; }
  .chat-popout-btn { background: var(--surface-2); color: var(--muted); border: none;
    border-radius: 6px; width: 28px; height: 28px; padding: 0; flex-shrink: 0; cursor: pointer;
    display: flex; align-items: center; justify-content: center; }
  .chat-popout-btn:hover { color: var(--text); }
  .chat-menu-wrap { position: relative; flex-shrink: 0; }
  .chat-menu-dd { position: absolute; top: 34px; right: 0; z-index: 20; display: none;
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: .65rem; width: 210px; box-shadow: 0 12px 28px rgba(0,0,0,.35); }
  .chat-menu-dd.open { display: block; }
  .chat-menu-dd .cmd-note { font-size: .68rem; color: var(--muted); margin-bottom: .5rem; line-height: 1.3; }
  .chat-menu-dd .cmd-row { display: flex; align-items: center; justify-content: space-between; padding: .3rem 0; }
  .chat-menu-dd .cmd-label { font-size: .8rem; }
  .chat-menu-dd input[type=number] { width: 55px; }
  .chat-box.chat-box-full { flex: 1; min-height: 0; max-height: none; }
  .chat-send-row { display: flex; gap: .4rem; padding-top: .5rem; flex-shrink: 0; }
  .chat-send-row input { flex: 1; min-width: 0; }
  .viewer-bar { display: flex; gap: .7rem; flex-wrap: wrap; padding-top: .5rem;
    margin-top: .3rem; border-top: 1px solid var(--border); font-size: .75rem; color: var(--muted); }
  .viewer-bar .vb-item { display: flex; align-items: center; gap: .3rem; }
  .conn .copyrow code { flex: 1; font-family: ui-monospace, monospace; font-size: .8rem;
    color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conn button { background: var(--surface-2); color: var(--muted); padding: .3rem .55rem;
    font-size: .75rem; border: none; border-radius: 6px; cursor: pointer; }
  .conn button:hover { color: var(--text); }

  /* ── Campos ocultables (claves de stream, IP pública) ── */
  .eyerow { display: flex; gap: .4rem; align-items: center; }
  .eyerow input { flex: 1; }
  .eye-btn, .copy-btn { background: var(--surface-2); color: var(--muted); border: none; border-radius: 6px;
    width: 30px; height: 30px; padding: 0; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    cursor: pointer; }
  .eye-btn:hover, .copy-btn:hover { color: var(--text); }

  /* ── Destination cards ── */
  .card { background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 1.1rem 1.2rem; }
  .card.tiktok { border-color: var(--accent); }
  /* flex-wrap: la sidebar es angosta — nombre + píldora + métricas + sparkline no siempre
     caben en una sola línea, que baje a la siguiente en vez de desbordar la tarjeta. */
  .card-head { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; margin-bottom: .8rem; }
  .card-head .name { font-weight: 600; font-size: 1rem; flex: 1; }
  .pill { font-size: .7rem; padding: .15rem .5rem; border-radius: 999px;
    background: var(--surface-2); color: var(--muted); white-space: nowrap; }
  .pill.live { background: rgba(46,160,67,.15); color: var(--live); }
  .pill.reconnecting { background: rgba(240,162,58,.15); color: var(--warn); }
  .pill.failed { background: rgba(248,81,73,.15); color: var(--danger); }
  .pill.lagging { background: rgba(240,162,58,.15); color: var(--warn); }
  .pill.on { background: rgba(46,160,67,.15); color: var(--live); }
  .pill.off { background: rgba(248,81,73,.15); color: var(--danger); }
  /* Gráfico de salud de red por destino — sparkline de bitrate reciente (ver
     trackMetricsHistory/sparklineSvg()). margin-left:auto la empuja al borde derecho
     de .card-head aunque no haya un elemento flex:1 hermano (caso de .pb-rtmp). */
  svg.spark { flex-shrink: 0; opacity: .9; margin-right: .5rem; }
  .card-head svg.spark { margin-left: auto; }
  .spark-slot { flex-shrink: 0; }
  .metrics { font-size: .72rem; color: var(--muted); margin-left: auto;
    font-variant-numeric: tabular-nums; white-space: nowrap; }
  .retry { background: var(--danger); color: #fff; }
  label { display: block; font-size: .75rem; color: var(--muted); margin: 0 0 .25rem; }
  input[type=text], input[type=password], input[type=number] { width: 100%; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 8px; padding: .5rem .65rem; font-size: .88rem;
    font-family: ui-monospace, monospace; }
  input[type=text]:focus, input[type=password]:focus, input[type=number]:focus { outline: none; border-color: var(--accent); }
  /* Los navegadores agregan un ícono nativo de mostrar/ocultar en type=password — ya
     tenemos nuestro propio .eye-btn al lado, el nativo duplica y no matchea el tema. */
  input[type=password]::-ms-reveal, input[type=password]::-ms-clear { display: none; }
  input[type=password]::-webkit-credentials-auto-fill-button,
  input[type=password]::-webkit-textfield-decoration-container { display: none !important; }
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
  #msg { position: fixed; bottom: 1rem; left: 50%;
    transform: translateX(-50%) translateY(6px);
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
    padding: .6rem 1rem; border-radius: 8px; opacity: 0;
    transition: opacity .3s var(--ease-out), transform .3s var(--ease-out); pointer-events: none;
    white-space: nowrap; z-index: 10; }
  #msg.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #msg.err { border-color: var(--danger); color: var(--danger); }

  /* ── Cuentas OAuth ── */
  #authSection { border-top: 1px solid var(--border); padding-top: .85rem; margin-top: .85rem; }
  .auth-hd { font-size: .68rem; font-weight: 600; color: var(--muted); text-transform: uppercase;
    letter-spacing: .08em; margin-bottom: .55rem; }
  .auth-row { display: flex; align-items: center; gap: .45rem; padding: .38rem 0;
    border-bottom: 1px solid var(--border); }
  .auth-row:last-child { border-bottom: none; }
  .p-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .auth-name { flex: 1; font-size: .82rem; }
  .auth-user { font-size: .72rem; color: var(--muted); font-family: ui-monospace,monospace;
    max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .auth-soon { font-size: .68rem; color: var(--off); font-style: italic; }
  .auth-conn { font-size: .7rem; padding: .18rem .5rem; }
  .auth-disc { font-size: .68rem; padding: .14rem .38rem;
    background: transparent; border-color: var(--border); color: var(--muted); }
  .auth-disc:hover { border-color: var(--danger); color: var(--danger); }

  /* ── Platform blocks ── */
  .pb-block { border: 1px solid var(--border); border-radius: 12px; margin-bottom: .5rem; overflow: hidden; }
  /* Glow por estado del toggle de reenvío (solo bloques con destino RTMP configurado) —
     mismo patrón pulsante que .video-wrap (@property + @keyframes): verde si está
     activada, rojo si está apagada. Sin URL configurada no se aplica pb-on/pb-off — el
     bloque queda gris fijo, sin animar (ver stateClass en renderPlatforms()). */
  @property --glow-pb { syntax: '<color>'; inherits: false; initial-value: #2ea043; }
  .pb-block.pb-on, .pb-block.pb-off {
    border-color: color-mix(in srgb, var(--glow-pb) 45%, var(--border));
    box-shadow:
      0 8px 25px -8px color-mix(in srgb, var(--glow-pb) 55%, transparent),
      inset 0 0 16px -8px color-mix(in srgb, var(--glow-pb) 50%, transparent);
    animation: pbGlowOn 5s ease-in-out infinite;
  }
  @keyframes pbGlowOn { 0%, 100% { --glow-pb: #2ea043; } 50% { --glow-pb: #56d364; } }
  @keyframes pbGlowOff { 0%, 100% { --glow-pb: #f85149; } 50% { --glow-pb: #f0a23a; } }
  .pb-block.pb-off { animation-name: pbGlowOff; }
  @media (prefers-reduced-motion: reduce) {
    .pb-block.pb-on { animation: none; --glow-pb: #2ea043; }
    .pb-block.pb-off { animation: none; --glow-pb: #f85149; }
  }
  .pb-head { display: flex; align-items: center; gap: .45rem; padding: .55rem .9rem;
    cursor: pointer; user-select: none; background: var(--surface); transition: background .15s var(--ease-out); }
  .pb-head:hover { background: var(--surface-2); }
  .pb-chevron { color: var(--muted); transition: transform .2s var(--ease-out); flex-shrink: 0;
    font-style: normal; font-size: .6rem; display: inline-block; }
  .pb-block.open > .pb-head .pb-chevron { transform: rotate(90deg); }
  .pb-body {
    display: grid;
    grid-template-rows: 0fr;
    border-top: 0px solid var(--border);
    transition: grid-template-rows .2s var(--ease-out), border-top-width .2s var(--ease-out);
  }
  .pb-block.open > .pb-body { grid-template-rows: 1fr; border-top-width: 1px; }
  .pb-body-inner { overflow: hidden; padding: 0 .9rem; }
  .pb-block.open > .pb-body > .pb-body-inner { padding: .65rem .9rem; }

  /* Submenú anidado (ej. Conexión servidor / Conexión del chat dentro de Información de
     conexión): plano, sin su propia tarjeta — evita el look "caja dentro de caja dentro
     de caja" cuando ya está adentro de un .pb-block con borde. */
  .pb-subblock { border: none; border-radius: 0; margin-bottom: 0; background: transparent; }
  .pb-subblock + .pb-subblock { margin-top: .35rem; padding-top: .35rem; border-top: 1px solid var(--border); }
  .pb-subblock > .pb-head { background: transparent; padding: .3rem .1rem; }
  .pb-subblock > .pb-head:hover { background: transparent; }
  .pb-subblock > .pb-head:hover .pb-head-name { color: var(--text); }
  .pb-subblock.open > .pb-body { border-top-width: 0; }
  /* .conn en el wrapper del submenú no alcanza a los .field (quedan 2 niveles más abajo,
     dentro de .pb-body-inner) — el gap real va acá, donde sí son hijos directos. */
  .pb-subblock.open > .pb-body > .pb-body-inner { display: flex; flex-direction: column; gap: .6rem; padding: .5rem .1rem .15rem; }
  .pb-head-name { flex: 1; font-size: .88rem; font-weight: 600; }
  .pb-user { font-size: .68rem; color: var(--muted); font-family: ui-monospace,monospace;
    max-width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pb-soon-tag { font-size: .65rem; color: var(--off); font-style: italic; }
  /* Plano a propósito — iba con su propia tarjeta (bg + borde) igual que .pb-block que
     lo contiene, mismo look "caja dentro de caja" que ya se corrigió en Información de
     conexión (.pb-subblock). Acá no hace falta ni ese nivel intermedio. */
  .pb-rtmp { margin-bottom: .55rem; }
  .pb-rtmp label { font-size: .7rem; }
  .pb-rtmp input[type=text] { font-size: .82rem; padding: .38rem .5rem; }
  .pb-rtmp .row { margin-top: .5rem; gap: .4rem; }
  .pb-rtmp .save { padding: .38rem .6rem; font-size: .78rem; }
  .pb-rtmp .del { padding: .38rem .6rem; font-size: .78rem; }
  .pb-rtmp .auto-note { font-size: .68rem; }
  .pb-add-rtmp-btn { background: transparent; border: 1px dashed var(--border); color: var(--muted);
    width: 100%; padding: .38rem; font-size: .76rem; border-radius: 8px; font-weight: 400; }
  .pb-add-rtmp-btn:hover { border-color: var(--accent); color: var(--accent); }
  .pb-add-rtmp-form { margin-top: .45rem; }
  .stream-info-btn { display: flex; align-items: center; justify-content: center; gap: .45rem;
    width: 100%; margin-bottom: .75rem; padding: .6rem; border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    color: var(--accent); font-size: .85rem; font-weight: 600;
    transition: background .15s var(--ease-out), border-color .15s var(--ease-out); }
  .stream-info-btn:hover { background: color-mix(in srgb, var(--accent) 22%, transparent);
    border-color: var(--accent); }
  .custom-sep { height: 1px; background: var(--border); margin: .65rem 0; }
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
    <span class="stream-title-display" id="streamTitleDisplay" style="display:none"></span>
  </div>
  <div aria-hidden="true"></div>
</header>
<div class="side-actions">
  <div class="side-actions-top">
    <button class="sidebar-toggle-btn panel-open" id="chatBtn" onclick="showSidebarTab('chat')" title="Chat">
      <span class="icon-mask icon-chat"></span>
    </button>
    <button class="sidebar-toggle-btn" id="connBtn" onclick="showSidebarTab('conn')" title="Conexiones">
      <span class="icon-mask icon-connections"></span>
    </button>
  </div>
  <div class="side-actions-bottom">
    <button class="sidebar-toggle-btn" id="updateBtn" style="display:none" onclick="openUpdaterModal()" title="Actualización disponible">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      <span class="upd-dot"></span>
    </button>
    <button class="sidebar-toggle-btn" id="prefsBtn" onclick="openPrefs()" title="Preferencias">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </button>
  </div>
</div>
<main>
  <!-- Principal: preview + config OBS + grabador -->
  <div class="main-col">
    <section class="preview">
        <div class="video-wrap" id="videoWrap">
          <video id="player" muted playsinline></video>
          <div class="video-ph" id="videoPh">
            <span class="icon-mask icon-video-off" id="videoOffIcon"></span>
            <span id="videoPhText"></span>
          </div>
        </div>
        <div class="ingest-bar" id="ingestBar" style="display:none">
          <span class="ingest-pill" id="ingestVideo">—</span>
          <div class="vu" title="Nivel de audio (L / R)">
            <div class="vu-ch"><span class="vu-fill" id="vuL"></span></div>
            <div class="vu-ch"><span class="vu-fill" id="vuR"></span></div>
          </div>
        </div>
        <div class="pb-block open" id="connInfoBlock" style="margin-top:.75rem">
          <div class="pb-head" onclick="toggleConnInfo()">
            <i class="pb-chevron">&#9654;</i>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
              <line x1="6" y1="6" x2="6.01" y2="6"/>
              <line x1="6" y1="18" x2="6.01" y2="18"/>
            </svg>
            <span class="pb-head-name">Información de conexión</span>
          </div>
          <div class="pb-body"><div class="pb-body-inner">
            <div class="conn pb-block pb-subblock" id="connServerBlock">
              <div class="pb-head" onclick="toggleConnSub('connServerBlock')">
                <i class="pb-chevron">&#9654;</i>
                <span class="pb-head-name">Conexión servidor de streaming</span>
              </div>
              <div class="pb-body"><div class="pb-body-inner">
                <div class="field">
                  <label>Servidor RTMP (en tu software de streaming)</label>
                  <div class="copyrow"><code id="rtmpUrl">—</code><button onclick="copy('rtmpUrl')" class="copy-btn" title="copiar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>
                </div>
                <div class="field">
                  <label>Clave de retransmisión</label>
                  <div class="copyrow"><code id="streamKey">—</code><button onclick="copy('streamKey')" class="copy-btn" title="copiar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>
                </div>
                <div class="field" id="lanField" style="display:none">
                  <label>Desde otra máquina en tu red</label>
                  <div class="copyrow"><code id="lanRtmpUrl">—</code><button onclick="copy('lanRtmpUrl')" class="copy-btn" title="copiar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>
                </div>
                <div class="field" id="pubField" style="display:none">
                  <label>Desde fuera de tu red (requiere port forwarding en tu router)</label>
                  <div class="copyrow">
                    <code id="pubRtmpUrl">rtmp://&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;/live</code>
                    <button onclick="togglePubIp()" id="pubEyeBtn" class="eye-btn" title="Mostrar/ocultar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button>
                    <button onclick="copy('pubRtmpUrl')" class="copy-btn" title="copiar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
                  </div>
                </div>
              </div></div>
            </div>
            <div class="conn pb-block pb-subblock" id="connChatBlock">
              <div class="pb-head" onclick="toggleConnSub('connChatBlock')">
                <i class="pb-chevron">&#9654;</i>
                <span class="pb-head-name">Conexión del chat</span>
              </div>
              <div class="pb-body"><div class="pb-body-inner">
                <div class="field">
                  <label>URL del chat (fuente de Navegador en OBS / Streamlabs)</label>
                  <div class="copyrow"><code id="chatLocalUrl">—</code><button onclick="copy('chatLocalUrl')" class="copy-btn" title="copiar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>
                </div>
                <div class="field" id="chatLanField" style="display:none">
                  <label>Desde otra máquina en tu red</label>
                  <div class="copyrow"><code id="chatLanUrl">—</code><button onclick="copy('chatLanUrl')" class="copy-btn" title="copiar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>
                </div>
                <div class="field" id="chatPubField" style="display:none">
                  <label>Desde fuera de tu red (requiere port forwarding en tu router)</label>
                  <div class="copyrow">
                    <code id="chatPubUrl">http://&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;/chat-overlay</code>
                    <button onclick="toggleChatPubIp()" id="chatPubEyeBtn" class="eye-btn" title="Mostrar/ocultar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button>
                    <button onclick="copy('chatPubUrl')" class="copy-btn" title="copiar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
                  </div>
                </div>
              </div></div>
            </div>
            <div class="conn pb-block pb-subblock" id="connStreamDeckBlock">
              <div class="pb-head" onclick="toggleConnSub('connStreamDeckBlock')">
                <i class="pb-chevron">&#9654;</i>
                <span class="pb-head-name">Conexión plugin Stream Deck</span>
              </div>
              <div class="pb-body"><div class="pb-body-inner">
                <p class="auto-note">Solo necesario si vas a controlar Muxlyve desde un Stream Deck en otra máquina (emisora secundaria). Si el Stream Deck está en este mismo equipo, no hace falta.</p>
                <div class="field" id="panelTokenField" style="display:none">
                  <label>Token de acceso remoto (ALLOW_LAN_PANEL)</label>
                  <div class="copyrow">
                    <code id="panelTokenCode">&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;</code>
                    <button onclick="togglePanelToken()" id="panelTokenEyeBtn" class="eye-btn" title="Mostrar/ocultar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button>
                    <button onclick="copy('panelTokenCode')" class="copy-btn" title="copiar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
                  </div>
                </div>
                <p class="auto-note" id="panelTokenHint">Actívalo en <a href="#" onclick="closeConnInfoAndOpenPrefs(event)">Preferencias → Sistema → "Permitir Stream Deck / chat desde otra máquina"</a> y reinicia Muxlyve para generar el token.</p>
              </div></div>
            </div>
          </div></div>
        </div>
        <!-- Grabador de clips -->
        <div class="rec-section">
          <div class="rec-toggle-row">
            <div>
              <div class="rec-toggle-label">Activar buffer</div>
              <div class="rec-status" id="recStatus">Conecta tu software de streaming para usar el buffer.</div>
            </div>
            <div style="display:flex;align-items:center;gap:.5rem">
              <button class="eye-btn" id="openClipsFolderBtn" onclick="openClipsFolder()" title="Abrir carpeta de clips">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 4h4.7l2 2H20a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/>
                </svg>
              </button>
              <label class="sys-toggle">
                <input type="checkbox" id="recToggle" disabled onchange="toggleRec()">
                <span class="sys-toggle-track"></span>
              </label>
            </div>
          </div>
          <button id="clipSaveBtn" class="browse-btn" style="display:none;width:100%;margin-top:.65rem" onclick="doSaveClip()">Guardar clip</button>
          <div class="recent-clips" id="recentClips" style="display:none">
            <div class="recent-clips-head">Clips recientes</div>
            <div id="recentClipsList"></div>
          </div>
        </div>
      </section>
  </div>
  <!-- Sidebar colapsable: destinos -->
  <aside class="sidebar-col" id="sidebarCol">
    <div class="sidebar-inner" id="connPanel" style="display:none">
      <button class="stream-info-btn" onclick="openStreamInfo()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z"/>
        </svg>
        Modificar información del stream
      </button>
      <div id="platformList"></div>
      <div id="customList"></div>

      <details class="add" id="addDestDetails">
        <summary>+ Añadir destino personalizado</summary>
        <div class="add-card">
          <div class="field"><label>Nombre</label><input type="text" id="newName" placeholder="MiPlataforma"></div>
          <div class="row">
            <div class="field"><label>URL (rtmp:// · rtmps:// · srt://)</label><input type="text" id="newUrl" placeholder="rtmp://servidor/app/CLAVE"></div>
            <button class="save" onclick="addDest()">Añadir</button>
          </div>
        </div>
      </details>
    </div>

    <div class="sidebar-inner chat-panel" id="chatPanel" style="display:none">
      <div class="chat-panel-head">
        <span class="chat-panel-title">Chat en vivo</span>
        <div style="display:flex;gap:.35rem">
          <div class="chat-menu-wrap">
            <button class="chat-popout-btn" onclick="toggleChatMenu(event)" title="Moderación (Twitch)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            <div class="chat-menu-dd" id="chatMenuDd" onclick="event.stopPropagation()">
              <div class="cmd-note">Moderación (solo Twitch — Kick no lo soporta por API)</div>
              <div class="cmd-row"><span class="cmd-label">Solo emotes</span>
                <label class="switch"><input type="checkbox" id="emoteOnlyChk"><span class="thumb"></span></label></div>
              <div class="cmd-row"><span class="cmd-label">Solo suscriptores</span>
                <label class="switch"><input type="checkbox" id="subOnlyChk"><span class="thumb"></span></label></div>
              <div class="cmd-row"><span class="cmd-label">Modo lento</span>
                <label class="switch"><input type="checkbox" id="slowModeChk"><span class="thumb"></span></label></div>
              <div class="cmd-row"><span class="cmd-label">Segundos</span>
                <input type="number" id="slowSecondsInput" value="30" min="1" max="1800"></div>
              <button class="browse-btn" style="width:100%;margin-top:.4rem" onclick="applyChatMode(this)">Aplicar</button>
            </div>
          </div>
          <div class="chat-menu-wrap">
            <button class="chat-popout-btn" onclick="toggleOverlayInfo(event)" title="Usar chat en OBS / Streamlabs">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            </button>
            <div class="chat-menu-dd" id="overlayInfoDd" onclick="event.stopPropagation()">
              <div class="cmd-note">¿Quieres mostrar el chat en tu programa de transmisión (OBS, Streamlabs, etc.)? La URL para tu fuente de Navegador está en "Información de conexión" → "Conexión del chat".</div>
              <button class="browse-btn" style="width:100%" onclick="openChatConnInfo()">Ver información de conexión</button>
            </div>
          </div>
          <button class="chat-popout-btn" onclick="openChatWindow()" title="Abrir en ventana aparte">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </button>
        </div>
      </div>
      <div id="chatMessages" class="chat-box chat-box-full"></div>
      <div class="chat-send-row">
        <input type="text" id="chatSendInput" placeholder="Escribir en el chat" maxlength="500">
        <button class="chat-popout-btn" onclick="sendChatMessageUi(this)" title="Enviar a todas las plataformas">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
      <div id="viewerBar" class="viewer-bar" style="display:none"></div>
    </div>
  </aside>
</main>
<!-- Modal de Preferencias -->
<div class="prefs-overlay" id="prefsOverlay" onclick="if(event.target===this)closePrefs()">
  <div class="prefs-modal prefs-modal-wide">
    <div class="prefs-head">
      <h2>Preferencias</h2>
      <button class="prefs-close" onclick="closePrefs()">✕</button>
    </div>
    <div class="prefs-layout">
      <nav class="prefs-nav">
        <button class="prefs-nav-item" data-tab="sys" id="prefsNavSys" onclick="switchPrefsTab('sys')" style="display:none">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <span>Sistema</span>
          <svg class="prefs-nav-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="prefs-nav-item" data-tab="clips" onclick="switchPrefsTab('clips')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="10" y1="2" x2="14" y2="2"/><line x1="12" y1="14" x2="15" y2="11"/><circle cx="12" cy="14" r="8"/>
          </svg>
          <span>Grabador de clips</span>
          <svg class="prefs-nav-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="prefs-nav-item" data-tab="support" id="prefsNavSupport" onclick="switchPrefsTab('support')" style="display:none">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
          </svg>
          <span>Soporte</span>
          <svg class="prefs-nav-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="prefs-nav-item" data-tab="license" onclick="switchPrefsTab('license')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
          </svg>
          <span>Licencia</span>
          <svg class="prefs-nav-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </nav>
      <div class="prefs-panels">
        <div class="prefs-panel" id="sysSection" data-panel="sys">
          <div class="pref-row">
            <div>
              <div>Modo oscuro</div>
              <div class="pref-desc">Cambia entre tema claro y oscuro</div>
            </div>
            <label class="sys-toggle">
              <input type="checkbox" id="themeChk" onchange="toggleTheme()">
              <span class="sys-toggle-track"></span>
            </label>
          </div>
          <div class="pref-row">
            <div>
              <div>Idioma / Language</div>
            </div>
            <div style="display:flex;gap:.4rem">
              <button type="button" class="lang-opt-btn" id="langEsBtn" onclick="setAppLanguage('es')">Español</button>
              <button type="button" class="lang-opt-btn" id="langEnBtn" onclick="setAppLanguage('en')">English</button>
            </div>
          </div>
          <div class="pref-row">
            <div>
              <div>Iniciar con el sistema</div>
              <div class="pref-desc">Abre Muxlyve al iniciar sesión</div>
            </div>
            <label class="sys-toggle">
              <input type="checkbox" id="loginItemChk" onchange="toggleLoginItem()">
              <span class="sys-toggle-track"></span>
            </label>
          </div>
          <div class="pref-row" id="startMinRow" style="display:none">
            <div>
              <div>Iniciar minimizado en la bandeja</div>
              <div class="pref-desc">No abre la ventana — queda el ícono junto al reloj</div>
            </div>
            <label class="sys-toggle">
              <input type="checkbox" id="startMinChk" onchange="toggleLoginItem()">
              <span class="sys-toggle-track"></span>
            </label>
          </div>
          <div class="pref-row">
            <div>
              <div>Minimizar a la bandeja al cerrar</div>
              <div class="pref-desc">El botón cerrar oculta la app en vez de salir — solo se cierra desde el ícono de bandeja</div>
            </div>
            <label class="sys-toggle">
              <input type="checkbox" id="closeToTrayChk" onchange="toggleCloseToTray()">
              <span class="sys-toggle-track"></span>
            </label>
          </div>
          <div class="pref-row">
            <div>
              <div>Buscar actualizaciones</div>
              <div class="pref-desc" id="updateCheckDesc">Revisa si hay una versión nueva disponible</div>
            </div>
            <button id="updateCheckBtn" onclick="checkForUpdates()">Buscar</button>
          </div>
          <div class="pref-row">
            <div>
              <div>Permitir Stream Deck / chat desde otra máquina</div>
              <div class="pref-desc">Abre el panel a tu red local (LAN). Sin esto, el plugin de Stream Deck y el overlay de chat en OBS solo funcionan en este mismo equipo. Cualquiera en tu red podría controlar tus destinos mientras esté activo.</div>
            </div>
            <label class="sys-toggle">
              <input type="checkbox" id="allowLanChk" onchange="toggleAllowLan()">
              <span class="sys-toggle-track"></span>
            </label>
          </div>
          <div class="pref-row" id="allowLanRestartRow" style="display:none">
            <div class="pref-desc" style="color:var(--warn)">Reinicia Muxlyve para aplicar este cambio — no corta ninguna transmisión en curso hasta que lo hagas.</div>
            <button onclick="relaunchApp()">Reiniciar ahora</button>
          </div>
        </div>
        <div class="prefs-panel" id="prefsClipsBlock" data-panel="clips">
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
              <button id="browseBtn" class="browse-btn" onclick="browseFolder()" title="Elegir carpeta">…</button>
            </div>
          </div>
        </div>
        <div class="prefs-panel" id="reportSection" data-panel="support">
          <div class="pref-row">
            <div>
              <div>Reportar un problema</div>
              <div class="pref-desc">Envía un log de la app junto con tu descripción</div>
            </div>
            <button class="danger-btn" onclick="openReport()">Reportar</button>
          </div>
        </div>
        <div class="prefs-panel" id="prefsLicenseBlock" data-panel="license">
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
            <button class="lic-manage-btn" onclick="openAbout()">Acerca de Muxlyve</button>
            <button class="lic-danger-btn" onclick="releaseLic()">Liberar este equipo</button>
            <p class="lic-note">Podrás activar la app en otro equipo. Necesitarás tu clave para volver a activarla aquí.</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="prefs-overlay" id="reportOverlay" onclick="if(event.target===this)closeReport()">
  <div class="prefs-modal lic-modal">
    <div class="prefs-head">
      <h2>Reportar un problema</h2>
      <button class="prefs-close" onclick="closeReport()">✕</button>
    </div>
    <div class="field">
      <label>¿Qué pasó?</label>
      <textarea id="reportDesc" rows="4" placeholder="Describe brevemente el problema…"
        style="width:100%;resize:vertical;font-family:inherit;font-size:.85rem;padding:.5rem;
        border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)"></textarea>
    </div>
    <div class="pref-desc" style="margin:.6rem 0 .8rem">
      Se adjuntan automáticamente los últimos logs, tu versión y sistema operativo — no incluye claves ni contraseñas.
    </div>
    <button id="reportSendBtn" onclick="sendReport()" style="width:100%">Enviar reporte</button>
  </div>
</div>
<div class="prefs-overlay" id="aboutOverlay" onclick="if(event.target===this)closeAbout()">
  <div class="prefs-modal about-modal">
    <div class="prefs-head">
      <h2>Acerca de</h2>
      <button class="prefs-close" onclick="closeAbout()">✕</button>
    </div>
    <div class="about-logo">Muxlyve</div>
    <div class="about-version" id="aboutVersion">v0.0.0</div>
    <div class="about-divider"></div>
    <div class="about-dev">Desarrollado por <strong>BlacKraken Solutions</strong></div>
    <div class="about-copy" id="aboutCopy">© 2026 Muxlyve. Todos los derechos reservados.<br>Muxlyve es software propietario. Prohibida su distribución sin autorización.</div>
    <a class="about-link" href="https://blackraken.vercel.app" target="_blank">BlacKraken ↗</a>
    <div class="about-btn-row">
      <button class="about-close-btn" onclick="closeAbout()">Cerrar</button>
    </div>
  </div>
</div>

<!-- Modal propio de actualización — reemplaza dialog.showMessageBox (nativo, sin estilo
     propio posible). El contenido se llena en runtime según el evento que llegue de
     electron/updater.js — ver handleUpdaterEvent(). -->
<div class="prefs-overlay" id="updaterOverlay" onclick="if(event.target===this)closeUpdaterModal()">
  <div class="prefs-modal" style="width:380px">
    <div class="prefs-head">
      <h2 id="updaterTitle">Actualización</h2>
      <button class="prefs-close" onclick="closeUpdaterModal()">✕</button>
    </div>
    <p id="updaterMessage" style="margin:0 0 .5rem;font-size:.9rem"></p>
    <p id="updaterDetail" class="pref-desc" style="margin:0 0 1rem"></p>
    <div id="updaterProgressBox" style="display:none">
      <div class="upd-progress-track"><div class="upd-progress-fill" id="updaterProgressFill"></div></div>
      <p class="upd-progress-text" id="updaterProgressText"></p>
    </div>
    <div id="updaterButtons" style="display:flex;flex-direction:column;gap:.5rem"></div>
  </div>
</div>

<div class="prefs-overlay" id="streamInfoOverlay" onclick="if(event.target===this)closeStreamInfo()">
  <div class="prefs-modal">
    <div class="prefs-head">
      <h2>Información del stream</h2>
      <button class="prefs-close" onclick="closeStreamInfo()">✕</button>
    </div>
    <div class="field">
      <label>Título del stream</label>
      <div class="copyrow">
        <input type="text" id="titleInput" placeholder="¿Qué vas a transmitir hoy?">
      </div>
    </div>
    <div class="field" style="margin-top:.65rem">
      <label>Categoría / juego</label>
      <div class="copyrow">
        <input type="text" id="categoryInput" placeholder="Just Chatting, Minecraft…">
      </div>
    </div>
    <button class="browse-btn" style="width:100%;margin-top:1rem" onclick="applyStreamTitle(this)">Aplicar</button>
  </div>
</div>
<div id="msg"></div>
<script src="/flv.min.js"></script>
<script>
  // Barra de título fundida con la UI — el padding exacto depende de qué lado ocupan
  // los botones nativos (izquierda en Mac, derecha en Windows). Se aplica ya mismo,
  // antes de cualquier otra cosa, para que no haya parpadeo del layout sin compensar.
  (function () {
    const ua = navigator.userAgent;
    if (ua.includes('Mac')) document.body.classList.add('platform-darwin');
    else if (ua.includes('Windows')) document.body.classList.add('platform-win32');
  })();

  window.onerror = (msg, src, line, col, err) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#f85149;color:#fff;padding:8px 12px;font:13px monospace;white-space:pre-wrap';
    d.textContent = '[ERROR] ' + msg + ' (' + (src || '') + ':' + line + ':' + col + ')';
    document.body?.appendChild(d);
  };
  window.onunhandledrejection = (e) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:40px;left:0;right:0;z-index:9999;background:#d29922;color:#fff;padding:8px 12px;font:13px monospace;white-space:pre-wrap';
    d.textContent = '[PROMISE] ' + (e.reason?.message || e.reason || 'rejected');
    document.body?.appendChild(d);
  };
  const $ = (s) => document.querySelector(s);
  const PLATFORM_IDS = ['twitch', 'youtube', 'kick', 'tiktok'];
  const AUTH_PLATFORMS = [
    { id: 'twitch',  name: 'Twitch',  color: '#9147ff' },
    { id: 'youtube', name: 'YouTube', color: '#ff0000' },
    { id: 'kick',    name: 'Kick',    color: '#53fc18' },
    { id: 'tiktok',  name: 'TikTok',  color: '#fe2c55', soon: true },
  ];
  // Google todavía no aprobó la verificación OAuth — bloquea el login de YouTube SOLO en
  // producción empaquetada (en dev sigue funcionando para poder seguir probando/iterando
  // con Google). Cuando llegue la aprobación, cambiar esto a false y listo.
  const YOUTUBE_OAUTH_PENDING = true;
  let lastState = null;
  let lastAuthStatus = {};
  // Gráfico de salud de red por destino — solo en memoria del cliente (sin backend/DB):
  // ventana corta de bitrate reciente, se borra en cuanto el destino deja de estar 'live'
  // para no mezclar sesiones de transmisión distintas en la misma línea.
  const metricsHistory = {};
  const METRICS_HISTORY_MAX = 30; // ~1 min a ~2s por poll
  function trackMetricsHistory(state) {
    for (const d of state.destinations) {
      if (d.status === 'live' && d.metrics && typeof d.metrics.bitrate === 'number') {
        const hist = metricsHistory[d.name] || (metricsHistory[d.name] = []);
        hist.push(d.metrics.bitrate);
        if (hist.length > METRICS_HISTORY_MAX) hist.shift();
      } else {
        delete metricsHistory[d.name];
      }
    }
  }
  function sparkColor(pillCls) {
    if (pillCls === 'live') return 'var(--live)';
    if (pillCls === 'lagging' || pillCls === 'reconnecting') return 'var(--warn)';
    if (pillCls === 'failed') return 'var(--danger)';
    return 'var(--muted)';
  }
  function sparklineSvg(history, color) {
    if (!history || history.length < 2) return '';
    const w = 64, h = 20;
    const min = Math.min(...history), max = Math.max(...history);
    const range = (max - min) || 1;
    const pts = history.map((v, i) => {
      const x = (i / (history.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const last = history[history.length - 1];
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
      '" preserveAspectRatio="none"><title>' + last + ' kbps</title>' +
      '<polyline points="' + pts + '" fill="none" stroke="' + color +
      '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  // El refresh automático (cada 2s) reconstruye los bloques de plataforma desde cero —
  // sin esto, borraría el formulario "+ Añadir servidor RTMP" abierto y lo que llevas escrito.
  const pbAddOpen = {};
  const pbAddDraft = {};
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

  // Ícono de ojo (SVG, no emoji) para togglear campos ocultos. abierto=mostrar, cerrado=ocultar.
  function eyeSvg(open) {
    return open
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  }

  // Ícono SVG (no emoji) por plataforma, con el color de marca de fondo. Devuelve '' si no matchea.
  const PLATFORM_ICON_GLYPHS = {
    twitch: '<path fill="#fff" d="M5 3 3 6.5v12H7V21l3-2.5h3l5.5-5V3H5zm10 9-3 3h-3l-2.5 2.5V15H5V5h13v7z"/><path fill="#fff" d="M14.5 7h1.8v4h-1.8zM10.3 7h1.8v4h-1.8z"/>',
    youtube: '<path fill="#fff" d="M21 8s-.2-1.4-.8-2c-.7-.8-1.5-.8-1.9-.9C15.9 5 12 5 12 5s-3.9 0-6.3.1c-.4.1-1.2.1-1.9.9C3.2 6.6 3 8 3 8s-.2 1.6-.2 3.2v1.2c0 1.6.2 3.2.2 3.2s.2 1.4.8 2c.7.8 1.7.7 2.1.8C7.5 18.6 12 18.6 12 18.6s3.9 0 6.3-.2c.4 0 1.2-.1 1.9-.8.6-.6.8-2 .8-2s.2-1.6.2-3.2v-1.2C21.2 9.6 21 8 21 8zM9.9 14.2V9l5.4 2.6z"/>',
    kick: '<path fill="#0a0a0a" d="M4 4h4v4.2L11.8 4H16l-5.4 6L16 16h-4.2L8 11.8V16H4z"/>',
    tiktok: '<path fill="#fff" d="M15.5 3h-3v11.6a2.4 2.4 0 1 1-1.7-2.3v-3.1a5.5 5.5 0 1 0 4.7 5.4V9.1c1 .7 2.2 1.1 3.5 1.1V7.2c-1.9 0-3.5-1.6-3.5-3.6z"/>',
  };
  const PLATFORM_ICON_COLORS = { twitch: '#9147ff', youtube: '#ff0000', kick: '#53fc18', tiktok: '#010101' };
  // Insignia propia (no imitamos el ícono nativo de cada plataforma) para marcar "este
  // mensaje lo escribiste vos, el streamer" — chat.js ya calcula msg.isBroadcaster.
  const BROADCASTER_BADGE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="#f0a23a"><path d="M5 18h14l1.3-8-4.8 3-3.5-6-3.5 6-4.8-3z"/></svg>';
  const PIN_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>';
  function platformIconSvg(id, size) {
    const glyph = PLATFORM_ICON_GLYPHS[id];
    if (!glyph) return '';
    const s = size || 18;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" style="flex-shrink:0;border-radius:6px">' +
      '<rect width="24" height="24" rx="6" fill="' + PLATFORM_ICON_COLORS[id] + '"/>' + glyph + '</svg>';
  }
  // Empareja el nombre de un destino personalizado con una plataforma conocida (substring, sin distinguir mayúsculas).
  function matchPlatformId(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('twitch')) return 'twitch';
    if (n.includes('youtube') || /(^|[^a-z])yt([^a-z]|$)/.test(n)) return 'youtube';
    if (n.includes('kick')) return 'kick';
    if (n.includes('tiktok')) return 'tiktok';
    return null;
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
    return { cls: d.enabled ? 'on' : 'off', text: d.enabled ? 'activo' : 'apagado' };
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
      toggle.checked = false;
      saveBtn.style.display = 'none';
      status.className = 'rec-status';
      status.textContent = 'Conecta tu software de streaming para usar el buffer.';
    } else if (rec.active) {
      toggle.disabled = false;
      toggle.checked = true;
      saveBtn.style.display = '';
      status.className = 'rec-status on';
      status.textContent = '● Grabando — último ' + fmtDur(rec.duration) + ' disponible';
    } else {
      toggle.disabled = false;
      toggle.checked = false;
      saveBtn.style.display = 'none';
      status.className = 'rec-status';
      status.textContent = state.live ? 'Buffer inactivo.' : 'Se detuvo la emisión.';
    }
  }

  // ── Ingest: stats de video + VU meter de audio ──
  // SSE setea los objetivos; un loop de suavizado (ataque rápido / caída lenta) anima las barras.
  const vu = { tL: 0, tR: 0, dL: 0, dR: 0, live: false };
  function applyVu(el, v) {
    el.style.width = v + '%';
  }
  (function vuLoop() {
    const ease = (d, t) => d + (t - d) * (t > d ? 0.7 : 0.12); // sube rápido, baja suave
    vu.dL = ease(vu.dL, vu.live ? vu.tL : 0);
    vu.dR = ease(vu.dR, vu.live ? vu.tR : 0);
    applyVu($('#vuL'), Math.round(vu.dL));
    applyVu($('#vuR'), Math.round(vu.dR));
    requestAnimationFrame(vuLoop);
  })();

  (function initAudioSSE() {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/audio');
    es.onmessage = (e) => {
      try { const l = JSON.parse(e.data); vu.tL = l.l; vu.tR = l.r; } catch {}
    };
    // EventSource reconecta solo ante error; nada más que hacer.
  })();

  // Vuelca src/panel.js:debugLog() acá — es la única consola que el usuario puede abrir
  // en la app empaquetada (DevTools de esta ventana). Ver LAN pairing con Stream Deck.
  (function initDebugLogSSE() {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/debug-log');
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data);
        (entry.level === 'error' ? console.error : console.log)('[panel-debug]', entry.line);
      } catch {}
    };
  })();

  function updateIngest(state) {
    vu.live = !!state.live;
    const bar = $('#ingestBar');
    if (!state.live || !state.ingest) {
      bar.style.display = 'none';
      vu.tL = vu.tR = 0;
      return;
    }
    bar.style.display = '';
    const ing = state.ingest;
    const parts = [];
    if (ing.width && ing.height) parts.push(ing.width + '×' + ing.height);
    if (ing.fps != null) parts.push(ing.fps + ' fps');
    $('#ingestVideo').textContent = 'Entrada: ' + (parts.join(' · ') || '—');
  }

  function render(state) {
    lastState = state;
    trackMetricsHistory(state);
    $('#liveDot').className = 'dot' + (state.live ? ' on' : '');
    $('#liveTxt').textContent = state.live ? 'En vivo' : 'esperando señal';
    $('#uptime').textContent = state.live ? fmtUptime(state.uptime) : '';
    $('#videoWrap').classList.toggle('live', state.live);
    updatePreview(state.live);
    updateRecorder(state);
    updateIngest(state);
    renderPlatforms();
    renderCustom(state);
  }

  function renderPlatforms() {
    if (!lastState) return;
    const state = lastState;
    const authSt = lastAuthStatus;
    const pl = $('#platformList');
    pl.innerHTML = '';
    for (const p of AUTH_PLATFORMS) {
      const rtmpDest = state.destinations.find(d => d.name.toLowerCase() === p.id) || null;
      const authS = authSt[p.id] || {};
      const storedOpen = localStorage.getItem('ms_pb_' + p.id);
      const isOpen = storedOpen === '1';
      const block = document.createElement('div');
      const stateClass = (rtmpDest && rtmpDest.url) ? (rtmpDest.enabled ? ' pb-on' : ' pb-off') : '';
      block.className = 'pb-block' + (isOpen ? ' open' : '') + stateClass;
      block.id = 'pb-' + p.id;

      // OAuth header part
      let oauthHtml = '';
      if (p.soon) {
        oauthHtml = '<span class="pb-soon-tag">OAuth próx.</span>';
      } else if (authS.connected) {
        const user = authS.username || 'conectado';
        oauthHtml = '<span class="pb-user" title="' + user + '">' + user + '</span>' +
          '<button class="auth-disc" data-id="' + p.id + '" onclick="disconnectPlatform(this.dataset.id)">&#10005;</button>';
      } else {
        oauthHtml = '<button class="auth-conn" data-id="' + p.id + '" onclick="connectPlatform(this.dataset.id)">Conectar</button>';
      }

      // Sparkline en la cabecera — visible con la tarjeta colapsada o no (entre el
      // nombre y "Conectar"). La píldora ("rezagado"/"reenviando") y las métricas en
      // texto se quedan adentro del cuerpo (pb-rtmp), solo visibles al expandir.
      let headSparkHtml = '';
      if (rtmpDest) {
        const headPill = pillFor(rtmpDest);
        headSparkHtml = sparklineSvg(metricsHistory[rtmpDest.name], sparkColor(headPill.cls));
      }

      // RTMP body
      let bodyHtml = '';
      if (rtmpDest) {
        const d = rtmpDest;
        const isTikTok = p.id === 'tiktok';
        const pill = pillFor(d);
        const metrics = metricsFor(d);
        bodyHtml += '<div class="pb-rtmp">';
        bodyHtml += '<div class="card-head"><span class="pill ' + pill.cls + '">' + pill.text + '</span>';
        if (metrics) bodyHtml += '<span class="metrics">' + metrics + '</span>';
        bodyHtml += '</div>';
        bodyHtml += '<div class="field"><label>URL RTMP' + (isTikTok ? ' &#8212; clave temporal' : '') + '</label>';
        bodyHtml += '<div class="eyerow"><input type="password" class="pb-url" value="" autocomplete="off">';
        bodyHtml += '<button type="button" class="eye-btn" onclick="toggleFieldEye(this)" title="Mostrar/ocultar">' + eyeSvg(false) + '</button></div></div>';
        bodyHtml += '<div class="row"><label class="switch">';
        bodyHtml += '<input type="checkbox" class="pb-toggle-cb" data-name="' + d.name + '"' + (d.enabled ? ' checked' : '') + ' onchange="togglePbRtmp(this)">';
        bodyHtml += '<span class="thumb"></span></label>';
        bodyHtml += '<button class="save" data-name="' + d.name + '" onclick="savePbRtmp(this)">Guardar</button>';
        if (d.status === 'failed') bodyHtml += '<button class="retry" data-name="' + d.name + '" onclick="retryPbRtmp(this)">Reintentar</button>';
        bodyHtml += '<button class="del" data-name="' + d.name + '" onclick="delPbRtmp(this)">Borrar</button></div>';
        if (d.enabled && !state.live) bodyHtml += '<p class="auto-note">* Arrancará cuando empiece la transmisión.</p>';
        if (isTikTok) bodyHtml += '<p class="auto-note">&#9651; TikTok regenera la clave cada sesión (~2h).</p>';
        bodyHtml += '</div>';
      } else {
        const isTikTok = p.id === 'tiktok';
        if (p.id === 'youtube' && authS.connected) {
          bodyHtml += '<p class="auto-note">&#8505; Conectado como ' + (authS.username || 'tu cuenta') +
            ' — no se pudo traer tu clave automáticamente (¿configuraste "Ir en vivo" en ' +
            'YouTube Studio al menos una vez?). Cópiala desde ahí y pégala abajo.</p>';
        }
        if (isTikTok) {
          bodyHtml += '<p class="auto-note">&#8505; TikTok no tiene login — consigue tu URL y clave así: ' +
            'abre la app de TikTok &#8594; toca + &#8594; LIVE &#8594; icono de ajustes antes de salir ' +
            'en vivo &#8594; "Transmitir desde PC/consola". Copia el Server URL y la Stream Key que te ' +
            'muestre y pégalos abajo. Esa clave expira en unas horas — genérala justo antes de transmitir.</p>';
        }
        const openStyle = pbAddOpen[p.id] ? ' style="display:none"' : '';
        const formStyle = pbAddOpen[p.id] ? '' : ' style="display:none"';
        bodyHtml += '<button class="pb-add-rtmp-btn" data-pid="' + p.id + '" onclick="showAddPlatformRtmp(this.dataset.pid)"' + openStyle + '>+ Añadir servidor RTMP</button>';
        bodyHtml += '<div class="pb-add-rtmp-form" id="pb-add-form-' + p.id + '"' + formStyle + '>';
        bodyHtml += '<div class="field"><label>URL RTMP' + (isTikTok ? ' &#8212; clave temporal TikTok' : '') + '</label>';
        bodyHtml += '<input type="text" id="pb-new-url-' + p.id + '" placeholder="rtmp://servidor/app/CLAVE" oninput="onPbDraftInput(this)"></div>';
        bodyHtml += '<div class="row" style="margin-top:.5rem">';
        bodyHtml += '<button class="save" data-pid="' + p.id + '" onclick="addPlatformRtmp(this.dataset.pid)">Añadir</button>';
        bodyHtml += '<button class="del" data-pid="' + p.id + '" onclick="cancelAddPlatformRtmp(this.dataset.pid)">Cancelar</button>';
        bodyHtml += '</div></div>';
      }

      block.innerHTML =
        '<div class="pb-head" data-pid="' + p.id + '" onclick="togglePlatformBlock(this.dataset.pid)">' +
        '<i class="pb-chevron">&#9654;</i>' +
        (platformIconSvg(p.id) || '<span class="p-dot" style="background:' + p.color + '"></span>') +
        '<span class="pb-head-name">' + p.name + '</span>' +
        headSparkHtml +
        oauthHtml +
        '</div>' +
        '<div class="pb-body"><div class="pb-body-inner">' + bodyHtml + '</div></div>';

      if (rtmpDest) block.querySelector('.pb-url').value = rtmpDest.url;
      if (pbAddDraft[p.id]) {
        const draftInput = block.querySelector('#pb-new-url-' + p.id);
        if (draftInput) draftInput.value = pbAddDraft[p.id];
      }
      pl.appendChild(block);
    }
  }

  // El input de "+ Añadir servidor RTMP" solo existe cuando rtmpDest es null (else branch),
  // así que su id siempre trae el pid — se guarda para sobrevivir el refresh cada 2s.
  function onPbDraftInput(input) {
    const pid = input.id.replace('pb-new-url-', '');
    pbAddDraft[pid] = input.value;
  }

  function renderCustom(state) {
    const cl = $('#customList');
    const custom = state.destinations.filter(d => !PLATFORM_IDS.includes(d.name.toLowerCase()));
    cl.innerHTML = '';
    if (custom.length === 0) return;
    cl.appendChild(Object.assign(document.createElement('div'), { className: 'custom-sep' }));
    for (const d of custom) {
      const isTikTok = /tiktok/i.test(d.name);
      const pill = pillFor(d);
      const metrics = metricsFor(d);
      const matchedId = matchPlatformId(d.name);
      const icon = matchedId ? platformIconSvg(matchedId, 16) : '';
      const card = document.createElement('div');
      card.className = 'card' + (isTikTok ? ' tiktok' : '');
      card.innerHTML = \`
        <div class="card-head">
          \${icon}
          <span class="name"></span>
          <span class="pill \${pill.cls}"></span>
          <span class="metrics"></span>
          <span class="spark-slot"></span>
        </div>
        <div class="field">
          <label>URL RTMP\${isTikTok ? ' &#8212; clave temporal TikTok' : ''}</label>
          <div class="eyerow">
            <input type="password" class="url" value="" autocomplete="off">
            <button type="button" class="eye-btn" onclick="toggleFieldEye(this)" title="Mostrar/ocultar">\${eyeSvg(false)}</button>
          </div>
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
        \${d.enabled && !state.live ? '<p class="auto-note">* Arrancará cuando empiece la transmisión.</p>' : ''}
        \${d.note ? '<p class="note"></p>' : ''}
      \`;
      card.querySelector('.name').textContent = d.name;
      card.querySelector('.pill').textContent = pill.text;
      card.querySelector('.metrics').textContent = metrics;
      card.querySelector('.spark-slot').innerHTML = sparklineSvg(metricsHistory[d.name], sparkColor(pill.cls));
      const urlInput = card.querySelector('.url');
      urlInput.value = d.url;
      if (d.note) card.querySelector('.note').textContent = '&#9651; ' + d.note;
      card.querySelector('.toggle-cb').onchange = (e) => save(d.name, urlInput.value, e.target.checked);
      card.querySelector('.save').onclick = () => save(d.name, urlInput.value, d.enabled);
      card.querySelector('.del').onclick = () => del(d.name);
      const retryBtn = card.querySelector('.retry');
      if (retryBtn) retryBtn.onclick = () => doRetry(d.name);
      cl.appendChild(card);
    }
  }

  function togglePlatformBlock(pid) {
    const block = $('#pb-' + pid);
    if (!block) return;
    const isOpen = block.classList.toggle('open');
    localStorage.setItem('ms_pb_' + pid, isOpen ? '1' : '0');
  }

  function toggleConnInfo() {
    const block = $('#connInfoBlock');
    const isOpen = block.classList.toggle('open');
    localStorage.setItem('ms_pb_conninfo', isOpen ? '1' : '0');
  }
  if (localStorage.getItem('ms_pb_conninfo') === '0') $('#connInfoBlock').classList.remove('open');

  function showAddPlatformRtmp(pid) {
    pbAddOpen[pid] = true;
    const form = $('#pb-add-form-' + pid);
    if (!form) return;
    form.previousElementSibling.style.display = 'none';
    form.style.display = '';
  }

  function cancelAddPlatformRtmp(pid) {
    pbAddOpen[pid] = false;
    delete pbAddDraft[pid];
    const form = $('#pb-add-form-' + pid);
    if (!form) return;
    form.style.display = 'none';
    form.previousElementSibling.style.display = '';
    const inp = $('#pb-new-url-' + pid);
    if (inp) inp.value = '';
  }

  // Evita que el poll de refresh() (cada 2s) pise una mutación en curso o
  // los campos que el usuario está llenando — root cause de que el formulario
  // "añadir servidor" se borrara solo, clics se perdieran, o un borrado se
  // revirtiera por una respuesta de refresh() llegando después.
  let destBusy = false;
  async function withDestBusy(fn) {
    destBusy = true;
    try { await fn(); } finally { destBusy = false; }
  }

  async function addPlatformRtmp(pid) {
    const inp = $('#pb-new-url-' + pid);
    const url = inp ? inp.value.trim() : '';
    if (!url) { toast('Pon una URL', true); return; }
    const name = (AUTH_PLATFORMS.find(p => p.id === pid) || {}).name || pid;
    try {
      await withDestBusy(async () => {
        pbAddOpen[pid] = false;
        delete pbAddDraft[pid];
        render(await api('POST', '/api/destinations', { name, url, enabled: false }));
      });
      toast(name + ' RTMP añadido');
    } catch (e) { toast(e.message, true); }
  }

  function savePbRtmp(btn) {
    const name = btn.dataset.name;
    const card = btn.closest('.pb-rtmp');
    save(name, card.querySelector('.pb-url').value, card.querySelector('.pb-toggle-cb').checked);
  }

  function delPbRtmp(btn) { del(btn.dataset.name); }
  function retryPbRtmp(btn) { doRetry(btn.dataset.name); }

  function togglePbRtmp(cb) {
    const card = cb.closest('.pb-rtmp');
    save(cb.dataset.name, card.querySelector('.pb-url').value, cb.checked);
  }

  async function doRetry(name) {
    try {
      await withDestBusy(async () => { render(await api('POST', '/api/retry?name=' + encodeURIComponent(name))); });
      toast('Reintentando ' + name);
    } catch (e) { toast(e.message, true); }
  }

  async function save(name, url, enabled) {
    try {
      await withDestBusy(async () => { render(await api('POST', '/api/destinations', { name, url, enabled })); });
      toast(enabled ? name + ' activado' : name + ' guardado');
    } catch (e) { toast(e.message, true); refresh(); }
  }
  async function del(name) {
    if (!confirm('¿Borrar ' + name + '?')) return;
    try {
      await withDestBusy(async () => { render(await api('DELETE', '/api/destinations?name=' + encodeURIComponent(name))); });
      toast(name + ' borrado');
    } catch (e) { toast(e.message, true); }
  }
  async function addDest() {
    const name = $('#newName').value.trim();
    const url = $('#newUrl').value.trim();
    if (!name) return toast('Pon un nombre', true);
    try {
      await withDestBusy(async () => { render(await api('POST', '/api/destinations', { name, url, enabled: false })); });
      $('#newName').value = ''; $('#newUrl').value = ''; toast(name + ' añadido');
    } catch (e) { toast(e.message, true); }
  }
  async function applyStreamTitle(btn) {
    const title = $('#titleInput').value.trim();
    const category = $('#categoryInput').value.trim();
    if (!title && !category) return toast('Escribe un título o una categoría primero', true);
    if (!window.msOAuth?.setTitle) return toast('No disponible en esta versión.', true);
    if (btn) btn.disabled = true;
    try {
      const results = await window.msOAuth.setTitle(title, category);
      const entries = Object.entries(results || {});
      if (!entries.length) { toast('Conecta Twitch o Kick primero.', true); return; }
      const failed = entries.filter(([, r]) => !r.ok);
      if (!failed.length) {
        if (title) localStorage.setItem('ms_stream_title', title);
        if (category) localStorage.setItem('ms_stream_category', category);
        updateStreamTitleDisplay();
        closeStreamInfo();
        toast('Actualizado en ' + entries.map(([p]) => p).join(' + '));
      } else {
        const [, firstErr] = failed[0];
        toast((firstErr.error || ('Falló en ' + failed.map(([p]) => p).join(', '))), true);
      }
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function toggleChatMenu(e) {
    e.stopPropagation();
    $('#chatMenuDd').classList.toggle('open');
  }
  function toggleOverlayInfo(e) {
    e.stopPropagation();
    $('#overlayInfoDd').classList.toggle('open');
  }
  function openChatConnInfo() {
    $('#overlayInfoDd').classList.remove('open');
    openSubBlock('connInfoBlock');
    openSubBlock('connChatBlock');
    $('#connChatBlock').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function openSubBlock(id) {
    const block = $('#' + id);
    if (!block) return;
    block.classList.add('open');
    localStorage.setItem('ms_pb_' + id, '1');
  }
  function toggleConnSub(id) {
    const block = $('#' + id);
    const isOpen = block.classList.toggle('open');
    localStorage.setItem('ms_pb_' + id, isOpen ? '1' : '0');
  }
  if (localStorage.getItem('ms_pb_connServerBlock') === '1') $('#connServerBlock').classList.add('open');
  if (localStorage.getItem('ms_pb_connChatBlock') === '1') $('#connChatBlock').classList.add('open');
  if (localStorage.getItem('ms_pb_connStreamDeckBlock') === '1') $('#connStreamDeckBlock').classList.add('open');
  document.addEventListener('click', () => {
    const dd = $('#chatMenuDd');
    if (dd) dd.classList.remove('open');
    const infoDd = $('#overlayInfoDd');
    if (infoDd) infoDd.classList.remove('open');
  });

  async function applyChatMode(btn) {
    const emoteOnly = $('#emoteOnlyChk').checked;
    const subscriberOnly = $('#subOnlyChk').checked;
    const slowOn = $('#slowModeChk').checked;
    const slowSeconds = slowOn ? Math.max(1, Number($('#slowSecondsInput').value) || 30) : 0;
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', '/api/chat-mode', { emoteOnly, subscriberOnly, slowSeconds });
      if (r.ok) toast('Chat de Twitch actualizado');
      else toast(r.error || 'No se pudo aplicar — ¿Twitch conectado?', true);
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function sendChatMessageUi(btn) {
    const input = $('#chatSendInput');
    const text = input.value.trim();
    if (!text) return;
    if (btn) btn.disabled = true;
    try {
      const results = await api('POST', '/api/chat-send', { text });
      const entries = Object.entries(results || {});
      if (!entries.length) { toast('Conecta Twitch o Kick primero.', true); return; }
      const failed = entries.filter(([, r]) => !r.ok);
      if (!failed.length) { input.value = ''; }
      else toast('Falló en ' + failed.map(([p]) => p).join(', '), true);
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  $('#chatSendInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessageUi($('.chat-send-row .chat-popout-btn'));
  });

  async function refresh() {
    if (destBusy) return;
    const activeTag = document.activeElement?.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
    // El ojito de "mostrar clave" solo cambia el type=password/text del <input> existente —
    // pero el poll reconstruye esas tarjetas desde cero (innerHTML) cada 2s, y el input nuevo
    // siempre nace en password. Si hay alguno revelado ahora mismo, no reconstruyas todavía.
    if (document.querySelector('.url[type="text"], .pb-url[type="text"]')) return;
    try { render(await api('GET', '/api/state')); } catch (e) { console.error('[refresh]', e); }
  }

  function copy(id) {
    const el = $('#' + id);
    const text = el.dataset.real || el.textContent;
    if (!text || text === '—') return;
    navigator.clipboard.writeText(text).then(() => toast('Copiado'), () => toast('No se pudo copiar', true));
  }

  let pubIpVisible = false;
  async function togglePubIp() {
    const el = $('#pubRtmpUrl');
    const btn = $('#pubEyeBtn');
    pubIpVisible = !pubIpVisible;
    if (pubIpVisible) {
      if (!el.dataset.real) {
        try {
          const { ip } = await api('GET', '/api/public-ip');
          if (ip && window._rtmpPort) el.dataset.real = 'rtmp://' + ip + ':' + window._rtmpPort + '/live';
        } catch {}
      }
      el.textContent = el.dataset.real || 'No disponible';
    } else {
      el.textContent = 'rtmp://' + '•'.repeat(12) + '/live';
    }
    if (btn) btn.innerHTML = eyeSvg(pubIpVisible);
  }

  let panelTokenVisible = false;
  function togglePanelToken() {
    const el = $('#panelTokenCode');
    const btn = $('#panelTokenEyeBtn');
    panelTokenVisible = !panelTokenVisible;
    el.textContent = panelTokenVisible ? (el.dataset.real || '—') : '•'.repeat(12);
    if (btn) btn.innerHTML = eyeSvg(panelTokenVisible);
  }

  let chatPubIpVisible = false;
  async function toggleChatPubIp() {
    const el = $('#chatPubUrl');
    const btn = $('#chatPubEyeBtn');
    chatPubIpVisible = !chatPubIpVisible;
    if (chatPubIpVisible) {
      if (!el.dataset.real) {
        try {
          const { ip } = await api('GET', '/api/public-ip');
          if (ip) el.dataset.real = 'http://' + ip + ':' + location.port + '/chat-overlay';
        } catch {}
      }
      el.textContent = el.dataset.real || 'No disponible';
    } else {
      el.textContent = 'http://' + '•'.repeat(12) + '/chat-overlay';
    }
    if (btn) btn.innerHTML = eyeSvg(chatPubIpVisible);
  }

  // Alterna type=password/text de cualquier <input> junto a un botón .eye-btn dentro de .eyerow.
  function toggleFieldEye(btn) {
    const input = btn.previousElementSibling;
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = eyeSvg(show);
  }

  // Arranca/para el reproductor flv.js según haya emisión. Solo crea el player
  // cuando OBS publica (si no, el FLV no existe y daría error). También se
  // destruye mientras la ventana está oculta/tapada (Espacios en Mac, minimizada
  // o detrás de otra app en Windows) — si no, el preview queda congelado en el
  // frame de cuando se ocultó y al volver parece un delay real de transmisión,
  // cuando en realidad el relay real (procesos FFmpeg aparte) nunca se detuvo.
  function updatePreview(live) {
    const ph = $('#videoPh');
    const shouldPlay = live && !document.hidden;
    if (shouldPlay && !player) {
      if (!(flvUrl && window.flvjs && flvjs.isSupported())) return;
      const video = $('#player');
      player = flvjs.createPlayer({ type: 'flv', url: flvUrl, isLive: true });
      player.attachMediaElement(video);
      player.load();
      player.play().catch(() => {});
      ph.style.display = 'none';
    } else if (!shouldPlay) {
      if (player) { player.destroy(); player = null; }
      // Sin señal: el ícono parpadeando alcanza — decirlo en texto además es redundante
      // con "esperando señal" que ya está en la barra superior. En pausa (ventana en
      // segundo plano) sí es información nueva, esa se queda como texto.
      $('#videoOffIcon').style.display = document.hidden ? 'none' : '';
      $('#videoPhText').textContent = document.hidden ? 'Vista en pausa (ventana en segundo plano)…' : '';
      ph.style.display = 'flex';
    }
  }
  document.addEventListener('visibilitychange', () => {
    updatePreview(lastState ? lastState.live : false);
  });

  async function loadConfig() {
    try {
      const c = await api('GET', '/api/config');
      flvUrl = c.flvUrl || '';
      $('#rtmpUrl').textContent = c.rtmpUrl || '—';
      $('#streamKey').textContent = c.streamKey || '—';
      if (c.lanRtmpUrl) {
        $('#lanRtmpUrl').textContent = c.lanRtmpUrl;
        $('#lanField').style.display = '';
      }
      if (c.rtmpPort) {
        window._rtmpPort = c.rtmpPort;
        $('#pubField').style.display = '';
      }
      $('#chatLocalUrl').textContent = location.origin + '/chat-overlay';
      if (c.lanIp) {
        $('#chatLanUrl').textContent = 'http://' + c.lanIp + ':' + location.port + '/chat-overlay';
        $('#chatLanField').style.display = '';
      }
      $('#chatPubField').style.display = '';
      if (c.panelToken) {
        $('#panelTokenCode').dataset.real = c.panelToken;
        $('#panelTokenField').style.display = '';
        $('#panelTokenHint').style.display = 'none';
      }
      if (c.version) window._appVersion = c.version;
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
    const wantActive = $('#recToggle').checked;
    try {
      await api('POST', wantActive ? '/api/record/start' : '/api/record/stop', { duration: recDurSel });
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
      loadRecentClips();
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; btn.textContent = 'Guardar clip'; }
  }

  async function openClipsFolder() {
    if (!window.msApp) return;
    try {
      const outputDir = $('#clipsDir').value.trim() || null;
      const q = outputDir ? '?dir=' + encodeURIComponent(outputDir) : '';
      const { dir } = await api('GET', '/api/clips' + q);
      await api('POST', '/api/clips/open', { path: dir });
    } catch (e) {
      toast(e.message, true);
    }
  }

  function fmtClipSize(bytes) {
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  // Construido en el cliente en tiempo de ejecución — translateHtml() traduce el HTML
  // servido una sola vez, no puede alcanzar texto armado después con JS. document.documentElement.lang
  // sí queda en 'en'/'es' correcto (ese <html lang="es"> es el primer key de tMap), así
  // que sirve como señal confiable del idioma actual sin duplicar todo el mecanismo de i18n.
  function fmtClipAge(mtime) {
    const isEn = document.documentElement.lang === 'en';
    const mins = Math.floor((Date.now() - mtime) / 60000);
    if (mins < 1) return isEn ? 'just now' : 'ahora mismo';
    if (mins < 60) return (isEn ? mins + ' min ago' : 'hace ' + mins + ' min');
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return (isEn ? hrs + 'h ago' : 'hace ' + hrs + 'h');
    return (isEn ? Math.floor(hrs / 24) + 'd ago' : 'hace ' + Math.floor(hrs / 24) + 'd');
  }
  const CLIP_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>';

  async function loadRecentClips() {
    if (!window.msApp) return;
    try {
      const outputDir = $('#clipsDir').value.trim() || null;
      const q = outputDir ? '?dir=' + encodeURIComponent(outputDir) : '';
      const { files } = await api('GET', '/api/clips' + q);
      const box = $('#recentClips');
      const list = $('#recentClipsList');
      if (!files.length) { box.style.display = 'none'; return; }
      box.style.display = '';
      list.innerHTML = '';
      for (const f of files) {
        const item = document.createElement('div');
        item.className = 'recent-clip-item';
        item.innerHTML = CLIP_ICON_SVG +
          '<div class="recent-clip-info">' +
          '<div class="recent-clip-name"></div>' +
          '<div class="recent-clip-meta"></div>' +
          '</div>';
        item.querySelector('.recent-clip-name').textContent = f.name;
        item.querySelector('.recent-clip-meta').textContent = fmtClipAge(f.mtime) + ' · ' + fmtClipSize(f.size);
        item.addEventListener('click', () => revealClip(f.path));
        list.appendChild(item);
      }
    } catch {}
  }

  async function revealClip(clipPath) {
    try { await api('POST', '/api/clips/open', { path: clipPath, reveal: true }); }
    catch (e) { toast(e.message, true); }
  }

  // Restaura preferencias guardadas en sesiones anteriores
  const savedDir = localStorage.getItem('ms_clips_dir');
  if (savedDir) $('#clipsDir').value = savedDir;
  const savedDur = Number(localStorage.getItem('ms_rec_dur'));
  if ([30, 60, 120].includes(savedDur)) setRecDur(savedDur);

  if (window.msApp) {
    loadRecentClips();
    setInterval(loadRecentClips, 20000);
  } else {
    $('#openClipsFolderBtn').style.display = 'none';
  }

  // ── Canvas fondo: nodos conectados ──
  (function initBg() {
    const canvas = document.getElementById('bgCanvas');
    const ctx = canvas.getContext('2d');
    const N = 18, D = 170, FPS = 15, MS = 1000 / FPS;
    let nodes = [], last = 0;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function resize() {
      canvas.width = innerWidth; canvas.height = innerHeight;
      nodes = Array.from({length: N}, () => ({
        x: Math.random() * canvas.width, y: Math.random() * canvas.height,
        vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35,
      }));
    }
    function draw(ts) {
      if (!reduceMotion) requestAnimationFrame(draw);
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
    if (reduceMotion) draw(0); else requestAnimationFrame(draw);
  })();

  // ── Tema claro/oscuro ──
  // En Windows, la barra de título fundida (titleBarOverlay) tiene su color fijado por
  // Electron al crear la ventana — hay que avisarle cada vez que cambia el tema, si no
  // se queda desincronizada (justo el problema original: la barra no seguía el tema).
  function syncTitleBarTheme() {
    if (window.msApp && window.msApp.setTitleBarTheme) {
      window.msApp.setTitleBarTheme(document.documentElement.dataset.theme !== 'light');
    }
  }
  // Mismo origen (http://localhost:19080) que la ventana de chat flotante — le avisa
  // el tema en vivo sin necesitar una vuelta por Electron IPC.
  let themeChannel = null;
  try { themeChannel = new BroadcastChannel('muxlyve-theme'); } catch {}

  function toggleTheme() {
    const dark = $('#themeChk').checked;
    const next = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = dark ? '' : 'light';
    localStorage.setItem('ms_theme', next);
    syncTitleBarTheme();
    if (themeChannel) themeChannel.postMessage(next);
  }
  const savedTheme = localStorage.getItem('ms_theme');
  if (savedTheme === 'light') {
    document.documentElement.dataset.theme = 'light';
  }
  syncTitleBarTheme();
  const savedTitle = localStorage.getItem('ms_stream_title');
  if (savedTitle) $('#titleInput').value = savedTitle;
  const savedCategory = localStorage.getItem('ms_stream_category');
  if (savedCategory) $('#categoryInput').value = savedCategory;
  updateStreamTitleDisplay();

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

  function closeConnInfoAndOpenPrefs(e) {
    e.preventDefault();
    openPrefs();
  }
  async function openPrefs() {
    $('#prefsOverlay').classList.add('open');
    $('#themeChk').checked = document.documentElement.dataset.theme !== 'light';
    loadLicenseInfo();
    const hasElectron = !!window.msApp;
    $('#prefsNavSys').style.display = hasElectron ? '' : 'none';
    $('#prefsNavSupport').style.display = hasElectron ? '' : 'none';
    const available = hasElectron ? ['sys', 'clips', 'support', 'license'] : ['clips', 'license'];
    const stored = localStorage.getItem('ms_prefs_tab');
    switchPrefsTab(available.includes(stored) ? stored : available[0]);
    if (hasElectron) {
      try {
        const s = await window.msApp.getLoginItem();
        $('#loginItemChk').checked = s.openAtLogin;
        $('#startMinChk').checked = s.startMinimized;
        $('#startMinRow').style.display = s.openAtLogin ? '' : 'none';
        $('#closeToTrayChk').checked = await window.msApp.getCloseToTray();
        $('#allowLanChk').checked = await window.msApp.getAllowLanPanel();
        markActiveLanguageBtn(await window.msApp.getLanguage());
      } catch {}
    }
  }
  function switchPrefsTab(tab) {
    document.querySelectorAll('.prefs-nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    document.querySelectorAll('.prefs-panel').forEach(el => el.classList.toggle('active', el.dataset.panel === tab));
    localStorage.setItem('ms_prefs_tab', tab);
  }
  function closePrefs() { $('#prefsOverlay').classList.remove('open'); }
  function markActiveLanguageBtn(lang) {
    $('#langEsBtn')?.classList.toggle('sel', lang === 'es');
    $('#langEnBtn')?.classList.toggle('sel', lang === 'en');
  }
  async function setAppLanguage(lang) {
    if (!window.msApp?.setLanguage) return;
    markActiveLanguageBtn(lang); // feedback inmediato — la recarga real la dispara main.js
    await window.msApp.setLanguage(lang);
  }
  async function toggleLoginItem() {
    if (!window.msApp) return;
    const openAtLogin = $('#loginItemChk').checked;
    const startMinimized = $('#startMinChk').checked;
    $('#startMinRow').style.display = openAtLogin ? '' : 'none';
    try { await window.msApp.setLoginItem(openAtLogin, startMinimized); } catch {}
  }
  async function toggleCloseToTray() {
    if (!window.msApp) return;
    try { await window.msApp.setCloseToTray($('#closeToTrayChk').checked); } catch {}
  }
  async function toggleAllowLan() {
    if (!window.msApp) return;
    try {
      await window.msApp.setAllowLanPanel($('#allowLanChk').checked);
      $('#allowLanRestartRow').style.display = '';
    } catch {}
  }
  async function relaunchApp() {
    if (!window.msApp) return;
    try { await window.msApp.relaunchApp(); } catch {}
  }

  async function checkForUpdates() {
    if (!window.msApp) return;
    const btn = $('#updateCheckBtn');
    btn.disabled = true;
    btn.textContent = 'Buscando…';
    try {
      const r = await window.msApp.checkForUpdates();
      if (!r.ok) { toast(r.error, true); }
      // Si sí hay algo que buscar, el resultado (hay/no hay actualización) llega vía un
      // diálogo nativo del proceso principal, no por aquí — este solo confirma el disparo.
    } catch (e) {
      toast(e.message, true);
    }
    btn.disabled = false;
    btn.textContent = 'Buscar';
  }

  function openReport() { $('#reportOverlay').classList.add('open'); }
  function closeReport() { $('#reportOverlay').classList.remove('open'); }

  async function sendReport() {
    if (!window.msApp) return;
    const btn = $('#reportSendBtn');
    const desc = $('#reportDesc').value.trim();
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const r = await window.msApp.sendReport(desc);
      if (r.ok) {
        toast('✓ Reporte enviado — gracias');
        $('#reportDesc').value = '';
        closeReport();
      } else {
        toast(r.error || 'No se pudo enviar el reporte', true);
      }
    } catch (e) {
      toast(e.message, true);
    }
    btn.disabled = false;
    btn.textContent = 'Enviar reporte';
  }

  async function loadLicenseInfo() {
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

  function openAbout() {
    // Versión ya cargada en init (appVersion global); año dinámico
    $('#aboutVersion').textContent = 'v' + (window._appVersion || '—');
    $('#aboutCopy').innerHTML = '© ' + new Date().getFullYear() + ' Muxlyve. Todos los derechos reservados.<br>Muxlyve es software propietario. Prohibida su distribución sin autorización.';
    $('#aboutOverlay').classList.add('open');
  }
  function closeAbout() { $('#aboutOverlay').classList.remove('open'); }

  // Botón secundario, estilo bordeado (mismo que "Acerca de Muxlyve"/"Gestionar
  // suscripción" en Licencia) — .lic-manage-btn. Primario: .browse-btn (morado sólido).
  function updaterBtn(label, primary, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = primary ? 'browse-btn' : 'lic-manage-btn';
    btn.style.width = '100%';
    btn.onclick = onClick;
    return btn;
  }
  // 'available' no abre el modal solo — queda pendiente y solo se ve un ícono discreto
  // sobre Ajustes (ver #updateBtn). El usuario decide cuándo ver el aviso completo.
  let pendingUpdatePayload = null;
  function openUpdaterModal() {
    if (!pendingUpdatePayload) return;
    $('#updateBtn').style.display = 'none';
    handleUpdaterEvent(pendingUpdatePayload);
  }
  function closeUpdaterModal() {
    $('#updaterOverlay').classList.remove('open');
    // Si cerró sin descargar (p.ej. "Ahora no"), la actualización sigue pendiente —
    // el ícono vuelve para que pueda retomarlo cuando quiera.
    if (pendingUpdatePayload) $('#updateBtn').style.display = 'flex';
  }
  function fmtMBs(bytesPerSecond) {
    return (bytesPerSecond / (1024 * 1024)).toFixed(1) + ' MB/s';
  }
  function showUpdaterProgress(percent, speedText) {
    $('#updaterButtons').style.display = 'none';
    const progBox = $('#updaterProgressBox');
    progBox.style.display = '';
    $('#updaterProgressFill').style.width = Math.max(0, Math.min(100, percent)) + '%';
    $('#updaterProgressText').textContent = Math.round(percent) + '%' + (speedText ? ' · ' + speedText : '');
  }
  function handleUpdaterEvent(payload) {
    const { type, title, message, detail, percent, bytesPerSecond } = payload || {};
    const isEn = document.documentElement.lang === 'en';
    if (type === 'progress') {
      // Solo actualiza la barra — no toca título/mensaje ya mostrados por el evento 'available'.
      showUpdaterProgress(percent, fmtMBs(bytesPerSecond));
      $('#updaterOverlay').classList.add('open');
      return;
    }
    $('#updaterTitle').textContent = title || 'Muxlyve';
    $('#updaterMessage').textContent = message || '';
    $('#updaterDetail').textContent = detail || '';
    $('#updaterDetail').style.display = detail ? '' : 'none';
    $('#updaterProgressBox').style.display = 'none';
    const box = $('#updaterButtons');
    box.style.display = 'flex';
    box.innerHTML = '';
    if (type === 'available') {
      box.appendChild(updaterBtn(isEn ? 'Download' : 'Descargar', true, () => {
        pendingUpdatePayload = null; // ya en curso — que no vuelva el ícono al cerrar
        showUpdaterProgress(0, isEn ? 'Starting…' : 'Iniciando…');
        window.msApp.downloadUpdate();
      }));
      box.appendChild(updaterBtn(isEn ? 'Download from the web' : 'Descargar desde la web', false, async () => {
        await window.msApp.openUpdateWeb();
        closeUpdaterModal();
      }));
      box.appendChild(updaterBtn(isEn ? 'Not now' : 'Ahora no', false, closeUpdaterModal));
    } else if (type === 'downloaded') {
      box.appendChild(updaterBtn(isEn ? 'Restart now' : 'Reiniciar ahora', true, () => window.msApp.installUpdate()));
      box.appendChild(updaterBtn(isEn ? 'Later' : 'Después', false, closeUpdaterModal));
    } else if (type === 'error') {
      box.appendChild(updaterBtn(isEn ? 'Download from the web' : 'Descargar desde la web', true, async () => {
        await window.msApp.openUpdateWeb();
        closeUpdaterModal();
      }));
      box.appendChild(updaterBtn(isEn ? 'Close' : 'Cerrar', false, closeUpdaterModal));
    } else {
      box.appendChild(updaterBtn('OK', true, closeUpdaterModal));
    }
    $('#updaterOverlay').classList.add('open');
  }
  function routeUpdaterEvent(payload) {
    if (payload && payload.type === 'available') {
      pendingUpdatePayload = payload;
      $('#updateBtn').style.display = 'flex';
      return;
    }
    handleUpdaterEvent(payload);
  }
  if (window.msApp?.onUpdaterEvent) window.msApp.onUpdaterEvent(routeUpdaterEvent);

  function openStreamInfo() { $('#streamInfoOverlay').classList.add('open'); }
  function closeStreamInfo() { $('#streamInfoOverlay').classList.remove('open'); }
  function updateStreamTitleDisplay() {
    const title = localStorage.getItem('ms_stream_title') || '';
    const el = $('#streamTitleDisplay');
    el.textContent = title;
    el.style.display = title ? '' : 'none';
    el.title = title;
  }

  async function releaseLic() {
    if (!confirm('¿Liberar este equipo? La app se cerrará y necesitarás tu clave para volver a activarla.')) return;
    await window.msLicense?.release();
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePrefs(); closeAbout(); closeReport(); } });

  // Pestañas del sidebar: Conexiones y Chat son mutuamente excluyentes. Click en la
  // pestaña activa colapsa todo el sidebar (mismo gesto que el botón único de antes).
  let activeSidebarTab = null;
  function showSidebarTab(tab) {
    const col = $('#sidebarCol');
    const isOpen = !col.classList.contains('collapsed');
    if (isOpen && activeSidebarTab === tab) {
      col.classList.add('collapsed');
      activeSidebarTab = null;
    } else {
      activeSidebarTab = tab;
      col.classList.remove('collapsed');
      $('#connPanel').style.display = tab === 'conn' ? '' : 'none';
      $('#chatPanel').style.display = tab === 'chat' ? '' : 'none';
    }
    $('#connBtn').classList.toggle('panel-open', activeSidebarTab === 'conn');
    $('#chatBtn').classList.toggle('panel-open', activeSidebarTab === 'chat');
  }

  function openChatWindow() {
    if (window.msApp && window.msApp.openChatWindow) {
      window.msApp.openChatWindow(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    } else {
      toast('Solo disponible en la app de escritorio', true);
    }
  }

  // ── Cuentas OAuth (solo Electron) ──
  async function loadAuthStatus() {
    if (!window.msOAuth) return;
    try {
      lastAuthStatus = await window.msOAuth.status();
      renderPlatforms();
    } catch {}
  }

  async function connectPlatform(platform) {
    if (platform === 'youtube' && YOUTUBE_OAUTH_PENDING && window._isPackaged) {
      toast('YouTube: esta funcionalidad estará disponible en una próxima versión (en espera de aprobación de Google).', true);
      return;
    }
    const btn = $('#pb-' + platform + ' .auth-conn');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
      const r = await window.msOAuth.connect(platform);
      if (r.ok) {
        const label = (AUTH_PLATFORMS.find(p => p.id === platform) || {}).name || platform;
        toast('✓ ' + label + ' conectado' + (r.username ? ' (' + r.username + ')' : ''));
        // Trae la clave de stream lista (p.ej. Twitch) — evita que el usuario tenga que
        // ir a buscarla y pegarla a mano tras conectar.
        if (r.rtmpUrl) {
          try { render(await api('POST', '/api/destinations', { name: label, url: r.rtmpUrl, enabled: false })); }
          catch { /* el destino se puede añadir a mano si esto falla */ }
        }
      } else { toast(r.error || 'Error al conectar', true); }
    } catch (e) { toast(e.message, true); }
    loadAuthStatus();
  }

  async function disconnectPlatform(platform) {
    try { await window.msOAuth.disconnect(platform); } catch {}
    loadAuthStatus();
  }

  // ── Chat unificado (fase 1: Twitch) ──
  // Intercala texto e imágenes de emote dentro de container, usando los rangos ya
  // normalizados por chat.js (mismo shape sea Twitch o Kick — ver parseTwitchEmotes/
  // parseKickEmotes ahí). Compartido conceptualmente con el de CHAT_WINDOW_HTML — no se
  // puede importar entre los dos documentos (ventanas separadas), así que está duplicado.
  function renderMessageBody(container, text, emotes) {
    if (!emotes || !emotes.length) { container.appendChild(document.createTextNode(text)); return; }
    let cursor = 0;
    for (const e of emotes) {
      if (e.start > cursor) container.appendChild(document.createTextNode(text.slice(cursor, e.start)));
      const img = document.createElement('img');
      img.className = 'chat-emote';
      img.src = e.url;
      img.alt = '';
      container.appendChild(img);
      cursor = e.end;
    }
    if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function appendChatMessage(msg) {
    const box = $('#chatMessages');
    if (!box) return;
    const empty = box.querySelector('.chat-empty');
    if (empty) empty.remove();
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    const row = document.createElement('div');
    row.className = 'chat-row';
    const iconHtml = platformIconSvg(msg.platform, 14);
    if (iconHtml) {
      const iconWrap = document.createElement('span');
      iconWrap.className = 'chat-icon';
      iconWrap.innerHTML = iconHtml; // SVG generado por nosotros — no viene del chat externo
      row.appendChild(iconWrap);
    }
    if (msg.isBroadcaster) {
      const badge = document.createElement('span');
      badge.className = 'chat-icon';
      badge.title = 'Vos (streamer)';
      badge.innerHTML = BROADCASTER_BADGE_SVG;
      row.appendChild(badge);
    }
    const textWrap = document.createElement('span');
    const nameEl = document.createElement('strong');
    nameEl.style.color = msg.color || '#9147ff';
    nameEl.textContent = msg.username || '???';
    textWrap.appendChild(nameEl);
    textWrap.appendChild(document.createTextNode(': '));
    renderMessageBody(textWrap, msg.message || '', msg.emotes);
    row.appendChild(textWrap);
    // Fijar: solo Twitch tiene API pública real para esto — Kick lo tiene en su dashboard
    // pero es un endpoint interno no expuesto a apps de terceros; YouTube no lo tiene.
    if (msg.platform === 'twitch' && msg.id) {
      const pinBtn = document.createElement('button');
      pinBtn.className = 'chat-pin-btn';
      pinBtn.title = 'Fijar este mensaje en Twitch';
      pinBtn.innerHTML = PIN_ICON_SVG;
      pinBtn.onclick = () => pinChatMessageUi(pinBtn, msg.id);
      row.appendChild(pinBtn);
    }
    box.appendChild(row);
    while (box.children.length > 200) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  async function pinChatMessageUi(btn, messageId) {
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/chat-pin', { messageId });
      if (r.ok) toast('Mensaje fijado en Twitch');
      else toast(r.error || 'No se pudo fijar', true);
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }
  function connectChatStream() {
    if (!window.EventSource) return;
    const box = $('#chatMessages');
    if (box) box.innerHTML = '<div class="chat-empty">Esperando mensajes…</div>';
    const es = new EventSource('/api/chat');
    es.onmessage = (e) => {
      try { appendChatMessage(JSON.parse(e.data)); } catch {}
    };
  }

  function renderViewerBar(counts) {
    const bar = $('#viewerBar');
    if (!bar) return;
    bar.innerHTML = '';
    let any = false;
    for (const p of ['twitch', 'kick', 'youtube']) {
      const v = counts[p];
      if (!v || !v.live) continue;
      any = true;
      const item = document.createElement('span');
      item.className = 'vb-item';
      item.innerHTML = platformIconSvg(p, 12);
      item.appendChild(document.createTextNode(v.count.toLocaleString('es')));
      bar.appendChild(item);
    }
    bar.style.display = any ? 'flex' : 'none';
  }
  async function pollViewers() {
    try { renderViewerBar(await api('GET', '/api/viewers')); } catch {}
  }

  if (window.msApp) { window.msApp.isPackaged().then(v => { window._isPackaged = v; }).catch(() => {}); }

  loadConfig();
  refresh();
  loadAuthStatus();
  showSidebarTab('chat'); // arranca siempre mostrando el chat
  connectChatStream();
  pollViewers();
  setInterval(refresh, 2000); // refleja estado en vivo y reenvíos activos
  setInterval(pollViewers, 20000); // el backend sondea Twitch/Kick/YouTube cada 30s, no hace falta más seguido
</script>
</body>
</html>`;

// Página independiente y minimalista para la ventana de chat "flotante" — separada de
// PANEL_HTML a propósito para no meter otro backtick dentro de ese template gigante.
const CHAT_WINDOW_HTML = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Muxlyve — Chat</title>
<style>
  :root { --bg: #0d1117; --text: #e6edf3; --muted: #8b949e; }
  [data-theme="light"] { --bg: #f0f2f5; --text: #1a1a2e; --muted: #5a6070; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; overflow: hidden; }
  #stars { position: fixed; inset: 0; pointer-events: none; z-index: 0; }
  .star { position: absolute; background: var(--text); border-radius: 50%;
    animation: twinkle 3.5s ease-in-out infinite; }
  @keyframes twinkle {
    0%, 100% { opacity: .15; } 50% { opacity: .9; }
  }
  @media (prefers-reduced-motion: reduce) {
    .star { animation: none; opacity: .5; }
  }
  #chatHeader { position: fixed; top: 0; left: 0; right: 0; height: 40px; z-index: 3;
    -webkit-app-region: drag; display: flex; align-items: center; justify-content: flex-end;
    padding: 0 8px; }
  #chatHeader button, #chatHeader .chat-menu-dd { -webkit-app-region: no-drag; }
  /* Botones nativos: Mac los deja a la izquierda (traffic lights), Windows a la derecha
     (titleBarOverlay) — el menú siempre va a la derecha del header, así que solo Windows
     necesita espacio extra para no quedar debajo de esos botones. */
  body.platform-win32 #chatHeader { padding-right: 150px; }
  .chat-menu-wrap { position: relative; }
  .chat-menu-btn { background: transparent; color: var(--muted); border: none;
    border-radius: 6px; width: 26px; height: 26px; padding: 0; cursor: pointer;
    display: flex; align-items: center; justify-content: center; }
  .chat-menu-btn:hover { color: var(--text); background: rgba(128,128,128,.15); }
  .switch { position: relative; display: inline-block; width: 36px; height: 20px; flex-shrink: 0; }
  .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
  .switch .thumb { position: absolute; inset: 0; background: rgba(128,128,128,.4);
    border-radius: 10px; cursor: pointer; transition: background .2s ease; }
  .switch .thumb::before { content: ''; position: absolute; width: 14px; height: 14px;
    left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: transform .2s ease; }
  .switch input:checked ~ .thumb { background: #7c5cff; }
  .switch input:checked ~ .thumb::before { transform: translateX(16px); }
  .chat-menu-dd { position: absolute; top: 30px; right: 0; z-index: 20; display: none;
    background: var(--bg); border: 1px solid rgba(128,128,128,.25); border-radius: 10px;
    padding: .6rem; width: 200px; box-shadow: 0 12px 28px rgba(0,0,0,.4); }
  .chat-menu-dd.open { display: block; }
  .chat-menu-dd .cmd-note { font-size: .66rem; color: var(--muted); margin-bottom: .5rem; line-height: 1.3; }
  .chat-menu-dd .cmd-row { display: flex; align-items: center; justify-content: space-between; padding: .25rem 0; font-size: .78rem; }
  .chat-menu-dd input[type=number] { width: 50px; background: var(--bg); border: 1px solid rgba(128,128,128,.25);
    color: var(--text); border-radius: 6px; padding: .25rem .35rem; font-size: .78rem; }
  .chat-menu-dd input[type=number]:focus { outline: none; border-color: var(--accent); }
  .chat-menu-dd button.apply { width: 100%; margin-top: .4rem; padding: .35rem; border-radius: 6px;
    border: none; background: var(--accent, #7c5cff); color: #fff; cursor: pointer; font-size: .78rem; }
  .cmd-status { font-size: .68rem; margin-top: .35rem; min-height: 1em; }
  #box { position: relative; z-index: 1; height: 100vh; overflow-y: auto; padding: .75rem;
    padding-top: 44px; padding-bottom: 74px; display: flex; flex-direction: column; gap: .3rem; }
  .row { font-size: .85rem; line-height: 1.4; overflow-wrap: break-word;
    display: flex; gap: .35rem; align-items: flex-start; }
  .row .chat-icon { flex-shrink: 0; margin-top: .15rem; }
  .row strong { margin-right: .3rem; }
  .chat-emote { height: 1.4em; width: auto; vertical-align: middle; display: inline-block; }
  .empty { color: var(--muted); font-size: .8rem; }
  .chat-pin-btn { margin-left: auto; flex-shrink: 0; background: transparent; border: none;
    color: var(--muted); cursor: pointer; opacity: 0; transition: opacity .15s ease; padding: 0 2px;
    display: flex; align-items: center; }
  .row:hover .chat-pin-btn { opacity: 1; }
  .chat-pin-btn:hover { color: #7c5cff; }
  .chat-pin-btn:disabled { opacity: .4; cursor: default; }
  #chatFooter { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2; background: var(--bg); }
  #chatSendRow { display: flex; gap: .4rem; padding: .4rem .75rem; border-top: 1px solid rgba(128,128,128,.2); }
  #chatSendRow input { flex: 1; min-width: 0; background: rgba(128,128,128,.12);
    border: 1px solid rgba(128,128,128,.25); border-radius: 6px; color: var(--text);
    padding: .3rem .5rem; font-size: .8rem; }
  #chatSendRow button { background: #7c5cff; border: none; border-radius: 6px; width: 30px;
    color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  #viewerBar { display: none; gap: .7rem; padding: .3rem .75rem .5rem;
    border-top: 1px solid rgba(128,128,128,.2); font-size: .72rem; color: var(--muted); }
  #viewerBar .vb-item { display: flex; align-items: center; gap: .3rem; }
</style>
</head>
<body>
<div id="chatHeader">
  <div class="chat-menu-wrap">
    <button class="chat-menu-btn" onclick="toggleChatMenu(event)" title="Moderación (Twitch)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
    <div class="chat-menu-dd" id="chatMenuDd" onclick="event.stopPropagation()">
      <div class="cmd-note">Moderación (solo Twitch — Kick no lo soporta por API)</div>
      <div class="cmd-row"><span>Solo emotes</span><label class="switch"><input type="checkbox" id="emoteOnlyChk"><span class="thumb"></span></label></div>
      <div class="cmd-row"><span>Solo suscriptores</span><label class="switch"><input type="checkbox" id="subOnlyChk"><span class="thumb"></span></label></div>
      <div class="cmd-row"><span>Modo lento</span><label class="switch"><input type="checkbox" id="slowModeChk"><span class="thumb"></span></label></div>
      <div class="cmd-row"><span>Segundos</span><input type="number" id="slowSecondsInput" value="30" min="1" max="1800"></div>
      <button class="apply" onclick="applyChatMode(this)">Aplicar</button>
      <div class="cmd-status" id="chatModeStatus"></div>
    </div>
  </div>
  <div class="chat-menu-wrap">
    <button class="chat-menu-btn" onclick="toggleOverlayInfo(event)" title="Usar chat en OBS / Streamlabs">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
    </button>
    <div class="chat-menu-dd" id="overlayInfoDd" onclick="event.stopPropagation()">
      <div class="cmd-note">¿Quieres mostrar el chat en tu programa de transmisión (OBS, Streamlabs, etc.)? Abre el panel principal de Muxlyve → "Información de conexión" → "Conexión del chat" para copiar la URL.</div>
    </div>
  </div>
</div>
<div id="stars"></div>
<div id="box"><div class="empty">Esperando mensajes…</div></div>
<div id="chatFooter">
  <div id="chatSendRow">
    <input type="text" id="chatSendInput" placeholder="Escribir en el chat" maxlength="500">
    <button onclick="sendChatMessageUi(this)" title="Enviar a todas las plataformas">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
      </svg>
    </button>
  </div>
  <div class="cmd-status" id="chatSendStatus" style="padding:0 .75rem"></div>
  <div id="viewerBar"></div>
</div>
<script>
  var ua = navigator.userAgent;
  if (ua.includes('Mac')) document.body.classList.add('platform-darwin');
  else if (ua.includes('Windows')) document.body.classList.add('platform-win32');

  function toggleChatMenu(e) {
    e.stopPropagation();
    document.getElementById('chatMenuDd').classList.toggle('open');
  }
  function toggleOverlayInfo(e) {
    e.stopPropagation();
    document.getElementById('overlayInfoDd').classList.toggle('open');
  }
  document.addEventListener('click', function () {
    var dd = document.getElementById('chatMenuDd');
    if (dd) dd.classList.remove('open');
    var infoDd = document.getElementById('overlayInfoDd');
    if (infoDd) infoDd.classList.remove('open');
  });
  function applyChatMode(btn) {
    var emoteOnly = document.getElementById('emoteOnlyChk').checked;
    var subscriberOnly = document.getElementById('subOnlyChk').checked;
    var slowOn = document.getElementById('slowModeChk').checked;
    var slowSeconds = slowOn ? Math.max(1, Number(document.getElementById('slowSecondsInput').value) || 30) : 0;
    var status = document.getElementById('chatModeStatus');
    btn.disabled = true;
    if (status) { status.textContent = 'Aplicando…'; status.style.color = ''; }
    fetch('/api/chat-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoteOnly: emoteOnly, subscriberOnly: subscriberOnly, slowSeconds: slowSeconds }),
    }).then(function (r) { return r.json(); }).then(function (r) {
      btn.disabled = false;
      if (!status) return;
      if (r && r.ok) { status.textContent = 'Aplicado ✓'; status.style.color = '#3fb950'; }
      else { status.textContent = (r && r.error) || 'No se pudo aplicar — ¿Twitch conectado?'; status.style.color = '#f85149'; }
    }).catch(function () {
      btn.disabled = false;
      if (status) { status.textContent = 'Error de conexión.'; status.style.color = '#f85149'; }
    });
  }

  function sendChatMessageUi(btn) {
    var input = document.getElementById('chatSendInput');
    var status = document.getElementById('chatSendStatus');
    var text = input.value.trim();
    if (!text) return;
    btn.disabled = true;
    fetch('/api/chat-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    }).then(function (r) { return r.json(); }).then(function (results) {
      btn.disabled = false;
      var entries = Object.keys(results || {});
      if (!entries.length) {
        if (status) { status.textContent = 'Conecta Twitch o Kick primero.'; status.style.color = '#f85149'; }
        return;
      }
      var failed = entries.filter(function (p) { return !results[p].ok; });
      if (!failed.length) {
        input.value = '';
        if (status) { status.textContent = ''; }
      } else if (status) {
        status.textContent = 'Falló en ' + failed.join(', ');
        status.style.color = '#f85149';
      }
    }).catch(function () {
      btn.disabled = false;
      if (status) { status.textContent = 'Error de conexión.'; status.style.color = '#f85149'; }
    });
  }
  document.getElementById('chatSendInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendChatMessageUi(document.querySelector('#chatSendRow button'));
  });

  // Tema inicial: viene por query string al abrir la ventana. Se mantiene sincronizado
  // en vivo con la app principal vía BroadcastChannel (mismo origen http://localhost).
  document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : '';
  try {
    var themeChannel = new BroadcastChannel('muxlyve-theme');
    themeChannel.onmessage = function (e) {
      document.documentElement.dataset.theme = e.data === 'light' ? 'light' : '';
    };
  } catch (err) {}

  (function () {
    var field = document.getElementById('stars');
    var n = 50;
    for (var i = 0; i < n; i++) {
      var s = document.createElement('div');
      s.className = 'star';
      var size = (Math.random() * 1.6 + .6).toFixed(1);
      s.style.width = size + 'px';
      s.style.height = size + 'px';
      s.style.left = (Math.random() * 100) + '%';
      s.style.top = (Math.random() * 100) + '%';
      s.style.animationDelay = (Math.random() * 3.5).toFixed(2) + 's';
      field.appendChild(s);
    }
  })();

  // Subset de platformIconSvg() del panel principal — este documento es una ventana
  // aparte (popout), no comparte script con el panel, así que va duplicado a propósito.
  var PLATFORM_ICON_GLYPHS = {
    twitch: '<path fill="#fff" d="M5 3 3 6.5v12H7V21l3-2.5h3l5.5-5V3H5zm10 9-3 3h-3l-2.5 2.5V15H5V5h13v7z"/><path fill="#fff" d="M14.5 7h1.8v4h-1.8zM10.3 7h1.8v4h-1.8z"/>',
    youtube: '<path fill="#fff" d="M21 8s-.2-1.4-.8-2c-.7-.8-1.5-.8-1.9-.9C15.9 5 12 5 12 5s-3.9 0-6.3.1c-.4.1-1.2.1-1.9.9C3.2 6.6 3 8 3 8s-.2 1.6-.2 3.2v1.2c0 1.6.2 3.2.2 3.2s.2 1.4.8 2c.7.8 1.7.7 2.1.8C7.5 18.6 12 18.6 12 18.6s3.9 0 6.3-.2c.4 0 1.2-.1 1.9-.8.6-.6.8-2 .8-2s.2-1.6.2-3.2v-1.2C21.2 9.6 21 8 21 8zM9.9 14.2V9l5.4 2.6z"/>',
    kick: '<path fill="#0a0a0a" d="M4 4h4v4.2L11.8 4H16l-5.4 6L16 16h-4.2L8 11.8V16H4z"/>',
    tiktok: '<path fill="#fff" d="M15.5 3h-3v11.6a2.4 2.4 0 1 1-1.7-2.3v-3.1a5.5 5.5 0 1 0 4.7 5.4V9.1c1 .7 2.2 1.1 3.5 1.1V7.2c-1.9 0-3.5-1.6-3.5-3.6z"/>',
  };
  var PLATFORM_ICON_COLORS = { twitch: '#9147ff', youtube: '#ff0000', kick: '#53fc18', tiktok: '#010101' };
  function platformIconSvg(id) {
    var glyph = PLATFORM_ICON_GLYPHS[id];
    if (!glyph) return '';
    return '<svg width="14" height="14" viewBox="0 0 24 24" style="flex-shrink:0;border-radius:4px">' +
      '<rect width="24" height="24" rx="6" fill="' + PLATFORM_ICON_COLORS[id] + '"/>' + glyph + '</svg>';
  }
  var BROADCASTER_BADGE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="#f0a23a"><path d="M5 18h14l1.3-8-4.8 3-3.5-6-3.5 6-4.8-3z"/></svg>';
  var PIN_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>';

  function pinChatMessageUi(btn, messageId) {
    btn.disabled = true;
    fetch('/api/chat-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: messageId }),
    }).then(function (r) { return r.json(); }).then(function () {
      btn.disabled = false;
    }).catch(function () { btn.disabled = false; });
  }

  // Mismo shape normalizado {start, end, url} que arma chat.js sea Twitch o Kick.
  function renderMessageBody(container, text, emotes) {
    if (!emotes || !emotes.length) { container.appendChild(document.createTextNode(text)); return; }
    var cursor = 0;
    for (var i = 0; i < emotes.length; i++) {
      var e = emotes[i];
      if (e.start > cursor) container.appendChild(document.createTextNode(text.slice(cursor, e.start)));
      var img = document.createElement('img');
      img.className = 'chat-emote';
      img.src = e.url;
      img.alt = '';
      container.appendChild(img);
      cursor = e.end;
    }
    if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function append(msg) {
    var box = document.getElementById('box');
    var empty = box.querySelector('.empty');
    if (empty) empty.remove();
    var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    var row = document.createElement('div');
    row.className = 'row';
    var iconHtml = platformIconSvg(msg.platform);
    if (iconHtml) {
      var iconWrap = document.createElement('span');
      iconWrap.className = 'chat-icon';
      iconWrap.innerHTML = iconHtml; // SVG generado por nosotros — no viene del chat externo
      row.appendChild(iconWrap);
    }
    if (msg.isBroadcaster) {
      var badge = document.createElement('span');
      badge.className = 'chat-icon';
      badge.title = 'Vos (streamer)';
      badge.innerHTML = BROADCASTER_BADGE_SVG;
      row.appendChild(badge);
    }
    var textWrap = document.createElement('span');
    var strong = document.createElement('strong');
    strong.style.color = msg.color || '#9147ff';
    strong.textContent = msg.username || '???';
    textWrap.appendChild(strong);
    renderMessageBody(textWrap, msg.message || '', msg.emotes);
    row.appendChild(textWrap);
    if (msg.platform === 'twitch' && msg.id) {
      var pinBtn = document.createElement('button');
      pinBtn.className = 'chat-pin-btn';
      pinBtn.title = 'Fijar este mensaje en Twitch';
      pinBtn.innerHTML = PIN_ICON_SVG;
      pinBtn.onclick = (function (id) { return function () { pinChatMessageUi(pinBtn, id); }; })(msg.id);
      row.appendChild(pinBtn);
    }
    box.appendChild(row);
    while (box.children.length > 300) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  var es = new EventSource('/api/chat');
  es.onmessage = function (e) {
    try { append(JSON.parse(e.data)); } catch (err) {}
  };

  function renderViewerBar(counts) {
    var bar = document.getElementById('viewerBar');
    if (!bar) return;
    bar.innerHTML = '';
    var any = false;
    ['twitch', 'kick', 'youtube'].forEach(function (p) {
      var v = counts[p];
      if (!v || !v.live) return;
      any = true;
      var item = document.createElement('span');
      item.className = 'vb-item';
      item.innerHTML = platformIconSvg(p);
      item.appendChild(document.createTextNode(v.count.toLocaleString('es')));
      bar.appendChild(item);
    });
    bar.style.display = any ? 'flex' : 'none';
  }
  function pollViewers() {
    fetch('/api/viewers').then(function (r) { return r.json(); }).then(renderViewerBar).catch(function () {});
  }
  pollViewers();
  setInterval(pollViewers, 20000);
</script>
</body>
</html>`;

// Fuente de navegador para OBS. Sin electron/preload — corre dentro del proceso Chromium
// embebido de OBS, así que solo puede depender de HTTP/SSE, igual que CHAT_WINDOW_HTML.
// Duplica el render de mensajes a propósito (mismo motivo que ese: documento aparte, sin
// script compartido) pero recorta todo lo interactivo — es solo para mostrar en escena.
const CHAT_OVERLAY_HTML = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Muxlyve — Chat overlay</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; background: transparent; overflow: hidden;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
  #box { height: 100vh; overflow-y: hidden; padding: .6rem; display: flex;
    flex-direction: column; gap: .3rem; justify-content: flex-end; }
  .row { font-size: 1.05rem; line-height: 1.4; overflow-wrap: break-word;
    display: flex; gap: .35rem; align-items: flex-start; color: #fff;
    text-shadow: 0 1px 3px rgba(0,0,0,.9), 0 0 6px rgba(0,0,0,.6); }
  .row .chat-icon { flex-shrink: 0; margin-top: .15rem; }
  .row strong { margin-right: .3rem; }
  .chat-emote { height: 1.4em; width: auto; vertical-align: middle; display: inline-block; }
</style>
</head>
<body>
<div id="box"></div>
<script>
  var PLATFORM_ICON_GLYPHS = {
    twitch: '<path fill="#fff" d="M5 3 3 6.5v12H7V21l3-2.5h3l5.5-5V3H5zm10 9-3 3h-3l-2.5 2.5V15H5V5h13v7z"/><path fill="#fff" d="M14.5 7h1.8v4h-1.8zM10.3 7h1.8v4h-1.8z"/>',
    youtube: '<path fill="#fff" d="M21 8s-.2-1.4-.8-2c-.7-.8-1.5-.8-1.9-.9C15.9 5 12 5 12 5s-3.9 0-6.3.1c-.4.1-1.2.1-1.9.9C3.2 6.6 3 8 3 8s-.2 1.6-.2 3.2v1.2c0 1.6.2 3.2.2 3.2s.2 1.4.8 2c.7.8 1.7.7 2.1.8C7.5 18.6 12 18.6 12 18.6s3.9 0 6.3-.2c.4 0 1.2-.1 1.9-.8.6-.6.8-2 .8-2s.2-1.6.2-3.2v-1.2C21.2 9.6 21 8 21 8zM9.9 14.2V9l5.4 2.6z"/>',
    kick: '<path fill="#0a0a0a" d="M4 4h4v4.2L11.8 4H16l-5.4 6L16 16h-4.2L8 11.8V16H4z"/>',
    tiktok: '<path fill="#fff" d="M15.5 3h-3v11.6a2.4 2.4 0 1 1-1.7-2.3v-3.1a5.5 5.5 0 1 0 4.7 5.4V9.1c1 .7 2.2 1.1 3.5 1.1V7.2c-1.9 0-3.5-1.6-3.5-3.6z"/>',
  };
  var PLATFORM_ICON_COLORS = { twitch: '#9147ff', youtube: '#ff0000', kick: '#53fc18', tiktok: '#010101' };
  function platformIconSvg(id) {
    var glyph = PLATFORM_ICON_GLYPHS[id];
    if (!glyph) return '';
    return '<svg width="14" height="14" viewBox="0 0 24 24" style="flex-shrink:0;border-radius:4px">' +
      '<rect width="24" height="24" rx="6" fill="' + PLATFORM_ICON_COLORS[id] + '"/>' + glyph + '</svg>';
  }
  var BROADCASTER_BADGE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="#f0a23a"><path d="M5 18h14l1.3-8-4.8 3-3.5-6-3.5 6-4.8-3z"/></svg>';

  function renderMessageBody(container, text, emotes) {
    if (!emotes || !emotes.length) { container.appendChild(document.createTextNode(text)); return; }
    var cursor = 0;
    for (var i = 0; i < emotes.length; i++) {
      var e = emotes[i];
      if (e.start > cursor) container.appendChild(document.createTextNode(text.slice(cursor, e.start)));
      var img = document.createElement('img');
      img.className = 'chat-emote';
      img.src = e.url;
      img.alt = '';
      container.appendChild(img);
      cursor = e.end;
    }
    if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function append(msg) {
    var box = document.getElementById('box');
    var row = document.createElement('div');
    row.className = 'row';
    var iconHtml = platformIconSvg(msg.platform);
    if (iconHtml) {
      var iconWrap = document.createElement('span');
      iconWrap.className = 'chat-icon';
      iconWrap.innerHTML = iconHtml; // SVG generado por nosotros — no viene del chat externo
      row.appendChild(iconWrap);
    }
    if (msg.isBroadcaster) {
      var badge = document.createElement('span');
      badge.className = 'chat-icon';
      badge.innerHTML = BROADCASTER_BADGE_SVG;
      row.appendChild(badge);
    }
    var textWrap = document.createElement('span');
    var strong = document.createElement('strong');
    strong.style.color = msg.color || '#9147ff';
    strong.textContent = msg.username || '???';
    textWrap.appendChild(strong);
    renderMessageBody(textWrap, msg.message || '', msg.emotes);
    row.appendChild(textWrap);
    box.appendChild(row);
    while (box.children.length > 40) box.removeChild(box.firstChild);
  }
  var es = new EventSource('/api/chat');
  es.onmessage = function (e) {
    try { append(JSON.parse(e.data)); } catch (err) {}
  };
</script>
</body>
</html>`;
