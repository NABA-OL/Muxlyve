// Desarrollado por BlacKraken Solutions (NABA-OL)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { loadAll, saveAll, isValidUrl, isPlayable } from './destinations.js';
import { isLive, relayInfo, uptimeSeconds, applyChange, stopByName, retry, recorderInfo, startRecording, stopRecording, saveClip, listRecentClips, deleteClip, fullRecordingInfo, startFullRecording, stopFullRecording, listRecentRecordings, deleteRecording, armRecording, armFullRecording, setRecDuration, setClipsDir, setRecordingsDir, listOrphanRecordings, convertOrphanRecording, resolveClipsDir, resolveRecordingsDir } from './relays.js';
import { ingestInfo, audioBus } from './monitor.js';
import { chatBus, getHistory as getChatHistory } from './chat.js';
import { getViewerCounts } from './viewers.js';
import { applyChatMode as applyChatModeBackend, sendChatMessage as sendChatMessageBackend, pinChatMessage as pinChatMessageBackend, unpinChatMessage as unpinChatMessageBackend, getChatPinned as getChatPinnedBackend } from './chatmod.js';
import { tMap } from './i18n.js';
import { getOrCreatePanelToken, isLoopback } from './panelAuth.js';
import { loadSettings, saveSettings, isValidStreamKey, isValidDiscordWebhook, isValidTelegramBot, MAX_DISCORD_WEBHOOKS, MAX_TELEGRAM_BOTS } from './settings.js';
import { testDiscordWebhook } from './notify.js';
import { testTelegramBot } from './telegram.js';
import { listPresets, savePreset, deletePreset, applyPresetToDestinations, deactivatePresetInDestinations, isPresetActive } from './presets.js';

// Orden por longitud descendente: si una key corta (" disponible") se reemplaza antes que
// una key larga que la contiene ("No disponible en esta versión."), la larga nunca vuelve a
// matchear y queda mezclada en dos idiomas. Ordenar así lo evita sin depender de mantener
// tMap en un orden particular a mano — se auto-corrige aunque se agreguen keys nuevas.
const TMAP_KEYS_BY_LENGTH = Object.keys(tMap).sort((a, b) => b.length - a.length);
// Cada entrada de tMap trae { en, fr, pt } — agregar un idioma nuevo es sumarlo acá y
// completar esa columna en todas las entradas de i18n.js, nada más se toca.
const SUPPORTED_LANGS = ['en', 'fr', 'pt'];

function translateHtml(html) {
  const lang = process.env.APP_LANG;
  if (!SUPPORTED_LANGS.includes(lang)) return html; // 'es', sin definir, o algo no soportado -> tal cual
  let translated = html;
  for (const es of TMAP_KEYS_BY_LENGTH) {
    const val = tMap[es][lang];
    if (val) translated = translated.split(es).join(val);
  }
  return translated;
}

function t(text) {
  // Mismo quirk de siempre: sin APP_LANG definido cae a inglés (solo se ve en dev/headless
  // sin .env — la app empaquetada siempre define APP_LANG antes de llegar acá).
  if (process.env.APP_LANG === 'es') return text;
  const lang = SUPPORTED_LANGS.includes(process.env.APP_LANG) ? process.env.APP_LANG : 'en';
  return (tMap[text] && tMap[text][lang]) || text;
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
const WEBHOOK_SVG     = readFileSync(path.join(PUBLIC, 'webhook.svg'));
// Fase 1 del refactor (docs/PLAN_REFACTOR_PANEL.md) — CSS de PANEL_HTML sacado de un
// <style> inline a archivo real. utf-8 explícito (no Buffer crudo como los SVG de
// arriba) porque este pasa por translateHtml() al servirse, que opera sobre string.
const PANEL_CSS = readFileSync(path.join(PUBLIC, 'panel.css'), 'utf-8');
const CHAT_WINDOW_CSS = readFileSync(path.join(PUBLIC, 'chat-window.css'), 'utf-8');
const CHAT_OVERLAY_CSS = readFileSync(path.join(PUBLIC, 'chat-overlay.css'), 'utf-8');
// Script clásico (sin type="module") a propósito — ver Trampa 1 en
// docs/PLAN_REFACTOR_PANEL.md: los onclick inline del HTML resuelven contra el scope
// global, que un módulo ES no expone.
const CHAT_WINDOW_JS = readFileSync(path.join(PUBLIC, 'chat-window.js'), 'utf-8');
// El script grande de PANEL_HTML — sin type="module" a propósito (ver Trampa 1 en
// docs/PLAN_REFACTOR_PANEL.md, 100+ onclick inline dependen del scope global).
const PANEL_CLIENT_JS = readFileSync(path.join(PUBLIC, 'panel-client.js'), 'utf-8');
// Fase 2 del refactor — lógica de chat compartida entre las 3 vistas, ver
// src/public/chat-render.js. Se sirve igual que los demás .js de src/public/.
const CHAT_RENDER_JS = readFileSync(path.join(PUBLIC, 'chat-render.js'), 'utf-8');

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
      maxBitrate: d.maxBitrate || null,
      transcoding: info.transcoding,
    };
  });
  return { live: isLive(), uptime: uptimeSeconds(), destinations, recorder: recorderInfo(), fullRecorder: fullRecordingInfo(), ingest: ingestInfo() };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // CN-001 (parte 2/2): rechaza Content-Type que no sea application/json. Los ataques
    // CSRF de "simple request" (los que no disparan preflight de CORS) dependen justo de
    // usar text/plain o application/x-www-form-urlencoded — un <form> normal o un fetch()
    // cross-origin sin headers custom NUNCA manda application/json. Sin Content-Type (no
    // lo manda ningún cliente HTTP no-browser, ni el propio panel en un POST sin body)
    // pasa igual — solo se rechaza un Content-Type explícito que no sea JSON.
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType && contentType !== 'application/json') {
      reject(new Error('Content-Type debe ser application/json'));
      return;
    }
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
  // Bitrate máximo opcional — vacío/0/inválido = sin cap, el destino sigue en -c copy
  // (ver relays.js). No se valida un rango: si el usuario pone algo absurdo, el propio
  // FFmpeg lo va a rechazar o el resultado se va a ver mal, no rompe nada de la app.
  const maxBitrateRaw = Number(input.maxBitrate);
  const maxBitrate = Number.isFinite(maxBitrateRaw) && maxBitrateRaw > 0 ? Math.round(maxBitrateRaw) : null;
  return { dest: { name, url, enabled, maxBitrate } };
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

  // POST /api/chat-unpin -> desfija (solo Twitch, ver src/chatmod.js).
  if (req.method === 'POST' && url.pathname === '/api/chat-unpin') {
    const body = await readBody(req);
    const messageId = String(body.messageId || '').trim();
    if (!messageId) return json(res, 400, { error: t('Falta el id del mensaje.') });
    const result = await unpinChatMessageBackend(messageId);
    return json(res, 200, result);
  }

  // GET /api/chat-pinned -> id del mensaje fijado ahora mismo en Twitch (o null si no hay
  // ninguno) — para que el botón arranque sincronizado con el estado real, no a ciegas.
  if (req.method === 'GET' && url.pathname === '/api/chat-pinned') {
    const result = await getChatPinnedBackend();
    return json(res, 200, result);
  }

  // POST /api/settings  { chatCommandsEnabled?, discordWebhooks?, telegramBots?,
  // liveMessage? } -> ajustes sueltos del motor que no encajan en ningún endpoint más
  // específico. YAGNI — si sigue creciendo, ahí sí vale la pena generalizar esto.
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const patch = {};
    if ('chatCommandsEnabled' in input) patch.chatCommandsEnabled = !!input.chatCommandsEnabled;
    if ('discordWebhooks' in input) {
      const list = Array.isArray(input.discordWebhooks) ? input.discordWebhooks : [];
      if (list.length > MAX_DISCORD_WEBHOOKS) {
        return json(res, 400, { error: t(`Máximo ${MAX_DISCORD_WEBHOOKS} webhooks de Discord.`) });
      }
      const cleaned = list.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
      if (cleaned.some((u) => !isValidDiscordWebhook(u))) {
        return json(res, 400, { error: t('Una de las URLs de Discord no es válida — debe ser https://discord.com/api/webhooks/...') });
      }
      patch.discordWebhooks = cleaned;
    }
    if ('telegramBots' in input) {
      const list = Array.isArray(input.telegramBots) ? input.telegramBots : [];
      if (list.length > MAX_TELEGRAM_BOTS) {
        return json(res, 400, { error: t(`Máximo ${MAX_TELEGRAM_BOTS} bots de Telegram.`) });
      }
      const cleaned = list
        .map((b) => ({ botToken: String(b?.botToken || '').trim(), chatId: String(b?.chatId || '').trim() }))
        .filter((b) => b.botToken || b.chatId);
      if (cleaned.some((b) => !isValidTelegramBot(b))) {
        return json(res, 400, { error: t('Uno de los bots de Telegram tiene el token o el chat ID inválido.') });
      }
      patch.telegramBots = cleaned;
    }
    if ('liveMessage' in input) {
      const msg = typeof input.liveMessage === 'string' ? input.liveMessage.trim() : '';
      if (msg.length > 2000) return json(res, 400, { error: t('El mensaje no puede superar los 2000 caracteres.') });
      patch.liveMessage = msg || null;
    }
    saveSettings(patch);
    return json(res, 200, { ok: true });
  }

  // POST /api/notify-test-discord  { url } -> prueba UN webhook puntual, sin necesidad
  // de haberlo guardado antes (así se puede probar antes de confirmar). Ignora el
  // cooldown de 30 min (ver src/notify.js) — botón "Probar" de cada fila.
  if (req.method === 'POST' && url.pathname === '/api/notify-test-discord') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const result = await testDiscordWebhook(input.url);
    return json(res, 200, result);
  }

  // POST /api/notify-test-telegram  { botToken, chatId } -> mismo criterio, para un bot
  // de Telegram puntual.
  if (req.method === 'POST' && url.pathname === '/api/notify-test-telegram') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const result = await testTelegramBot(input.botToken, input.chatId);
    return json(res, 200, result);
  }

  // POST /api/notify-test-all -> dispara el mensaje de aviso YA GUARDADO a TODOS los
  // canales configurados (Discord + Telegram) de una — botón "Probar" del modal de
  // mensaje (previsualiza cómo va a quedar en cada uno, no uno a la vez).
  if (req.method === 'POST' && url.pathname === '/api/notify-test-all') {
    const settings = loadSettings();
    const results = [];
    for (let i = 0; i < settings.discordWebhooks.length; i++) {
      results.push({ platform: 'discord', index: i + 1, ...(await testDiscordWebhook(settings.discordWebhooks[i])) });
    }
    for (let i = 0; i < settings.telegramBots.length; i++) {
      const bot = settings.telegramBots[i];
      results.push({ platform: 'telegram', index: i + 1, ...(await testTelegramBot(bot.botToken, bot.chatId)) });
    }
    return json(res, 200, { results });
  }

  // GET /api/presets -> perfiles guardados + si cada uno está activo AHORA MISMO (todos
  // sus destinos con enabled=true, ver isPresetActive en presets.js). El campo `active`
  // viaja calculado desde acá para que un consumidor externo (plugin de Stream Deck, ver
  // docs/STREAMDECK_PLUGIN.md) no tenga que pedir /api/state aparte solo para saber en
  // qué estado pintar su botón.
  if (req.method === 'GET' && url.pathname === '/api/presets') {
    const destinations = loadAll();
    const presets = listPresets().map((p) => ({ ...p, active: isPresetActive(destinations, p) }));
    return json(res, 200, { presets });
  }

  // POST /api/presets  { name } -> guarda el estado enabled ACTUAL de todos los destinos
  // bajo ese nombre. Si el nombre ya existe, lo pisa.
  if (req.method === 'POST' && url.pathname === '/api/presets') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    try {
      const presets = savePreset(input.name, loadAll());
      return json(res, 200, { presets });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // POST /api/presets/apply  { name } -> aplica: cada destino queda enabled según esté o
  // no en el preset. Mismo camino que el toggle por destino (saveAll + applyChange), para
  // no duplicar la lógica de arranque/parada de relays.
  if (req.method === 'POST' && url.pathname === '/api/presets/apply') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const preset = listPresets().find((p) => p.name === input.name);
    if (!preset) return json(res, 404, { error: t('Perfil no encontrado.') });
    const next = applyPresetToDestinations(loadAll(), preset);
    saveAll(next);
    next.forEach(applyChange);
    return json(res, 200, buildState());
  }

  // POST /api/presets/deactivate  { name } -> apaga SOLO los destinos que ese perfil
  // prende, sin tocar el resto (a diferencia de /apply, que es un intercambio total).
  // Pensado para el botón de "Perfil" del plugin de Stream Deck — un botón físico con un
  // solo estado ON/OFF necesita un "apagar esto puntual" que no pise otros destinos que
  // el usuario haya prendido a mano. Ver docs/STREAMDECK_PLUGIN.md.
  if (req.method === 'POST' && url.pathname === '/api/presets/deactivate') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const preset = listPresets().find((p) => p.name === input.name);
    if (!preset) return json(res, 404, { error: t('Perfil no encontrado.') });
    const next = deactivatePresetInDestinations(loadAll(), preset);
    saveAll(next);
    next.forEach(applyChange);
    return json(res, 200, buildState());
  }

  // DELETE /api/presets?name=X -> borra un perfil guardado.
  if (req.method === 'DELETE' && url.pathname === '/api/presets') {
    const name = url.searchParams.get('name');
    if (!name) return json(res, 400, { error: t('Falta el parámetro name.') });
    const presets = deletePreset(name);
    return json(res, 200, { presets });
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
      ? list.map((d, i) => (i === idx ? { ...d, url: dest.url, enabled: dest.enabled, maxBitrate: dest.maxBitrate } : d))
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

  // Duraciones del buffer rodante: 1/5/10/15 min. Ver src/relays.js — la nota sobre
  // tmpdir()/tmpfs en Linux (RAM en vez de disco) aplica sobre todo al tope de 15 min.
  const REC_DURATIONS = [60, 300, 600, 900];

  // POST /api/record/start  { duration?: 60|300|600|900 } — sin duration, usa la última
  // configurada (recorderInfo().duration): así un cliente que no conoce la preferencia
  // del usuario (ej. el plugin de Stream Deck) prende el buffer con la misma duración
  // que ya está seleccionada en Preferencias, sin tener que replicar ese ajuste aparte.
  // Sin señal todavía: no rechaza con 409 — "arma" el buffer (queda guardado, server-side,
  // no en el cliente) para que arranque solo apenas OBS conecte (ver onPublish en
  // relays.js). Mismo comportamiento sea el panel o el plugin de Stream Deck quien llame.
  if (req.method === 'POST' && url.pathname === '/api/record/start') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const dur = REC_DURATIONS.includes(Number(input.duration)) ? Number(input.duration) : recorderInfo().duration;
    armRecording(true, dur);
    if (isLive()) startRecording(dur);
    return json(res, 200, buildState());
  }

  // POST /api/record/stop — siempre desarma también (si no, la próxima vez que llegue
  // señal volvería a arrancar solo, aunque el usuario lo haya apagado a propósito).
  if (req.method === 'POST' && url.pathname === '/api/record/stop') {
    stopRecording();
    armRecording(false);
    return json(res, 200, buildState());
  }

  // POST /api/record/duration  { duration } — persiste SOLO la duración elegida (sin
  // armar ni reiniciar un buffer activo). Se llama apenas cambia la selección en
  // Preferencias, para que quede lista para el próximo arranque automático sin depender
  // de un des/re-armado manual — ver setRecDuration() en relays.js.
  if (req.method === 'POST' && url.pathname === '/api/record/duration') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!REC_DURATIONS.includes(Number(input.duration))) return json(res, 400, { error: 'Duración inválida.' });
    setRecDuration(Number(input.duration));
    return json(res, 200, { ok: true });
  }

  // POST /api/record/save  { duration?: 60|300|600|900, outputDir?: string } — sin duration,
  // usa la del buffer activo (recorderInfo().duration), mismo criterio que /api/record/start.
  if (req.method === 'POST' && url.pathname === '/api/record/save') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const dur = REC_DURATIONS.includes(Number(input.duration)) ? Number(input.duration) : recorderInfo().duration;
    const outputDir = typeof input.outputDir === 'string' && input.outputDir.trim() ? input.outputDir.trim() : null;
    // Log SIEMPRE (no gateado por ALLOW_LAN_PANEL como debugLog): a diferencia de
    // /api/state (poll cada 2s), esto solo dispara con un click explícito de "guardar
    // clip" — sirve para diagnosticar desde la consola si la request del Stream Deck
    // realmente llega, con qué body, y qué resultado da, sin depender de tener LAN
    // habilitada ni de que la ruta esté en DEBUG_LOG_ROUTES.
    console.log(`[record/save] request desde ${req.socket.remoteAddress} — duration=${input.duration ?? '(no enviado, usa ' + dur + ')'} outputDir=${outputDir ?? '(default)'}`);
    try {
      const filePath = await saveClip(dur, outputDir);
      console.log(`[record/save] OK — ${filePath}`);
      return json(res, 200, { ok: true, path: filePath });
    } catch (err) {
      console.error(`[record/save] FALLÓ — ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/fullrecord/start  { outputDir? } — grabación completa (archivo único con
  // toda la transmisión), independiente del buffer rodante de arriba. Ver relays.js.
  // Mismo criterio que /api/record/start: sin señal, queda "armada" en vez de rechazar.
  if (req.method === 'POST' && url.pathname === '/api/fullrecord/start') {
    let input;
    try { input = await readBody(req); } catch { input = {}; }
    const outputDir = typeof input.outputDir === 'string' && input.outputDir.trim() ? input.outputDir.trim() : null;
    armFullRecording(true);
    if (isLive()) startFullRecording(outputDir);
    return json(res, 200, buildState());
  }

  // POST /api/fullrecord/stop
  if (req.method === 'POST' && url.pathname === '/api/fullrecord/stop') {
    stopFullRecording();
    armFullRecording(false);
    return json(res, 200, buildState());
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
      const { dir, files, total } = listRecentClips(outputDir);
      return json(res, 200, { dir, files, total });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // DELETE /api/clips  { path, outputDir? } — borra un clip guardado. deleteClip()
  // valida que el path esté DENTRO de la carpeta de clips antes de borrar.
  if (req.method === 'DELETE' && url.pathname === '/api/clips') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!input.path) return json(res, 400, { error: t('Falta el parámetro path.') });
    try {
      deleteClip(input.path, input.outputDir || null);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/clips/set-dir  { dir } — persiste la carpeta de destino de clips
  // (settings.json, ver setClipsDir en relays.js). Antes esto solo vivía en localStorage
  // del panel — el plugin de Stream Deck no tiene acceso a eso, así que sus saves
  // siempre caían en la carpeta default aunque el usuario hubiera elegido otra acá.
  if (req.method === 'POST' && url.pathname === '/api/clips/set-dir') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    setClipsDir(typeof input.dir === 'string' ? input.dir : null);
    return json(res, 200, { ok: true });
  }

  // GET /api/recordings?dir=  → últimas grabaciones completas (.mp4 ya remuxeadas),
  // mismo criterio que /api/clips pero apuntando a resolveRecordingsDir().
  if (req.method === 'GET' && url.pathname === '/api/recordings') {
    const outputDir = url.searchParams.get('dir') || null;
    try {
      const { dir, files, total } = listRecentRecordings(outputDir);
      return json(res, 200, { dir, files, total });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // DELETE /api/recordings  { path, outputDir? } — borra una grabación completa. Mismo
  // guard de seguridad que DELETE /api/clips (path debe estar dentro del folder).
  if (req.method === 'DELETE' && url.pathname === '/api/recordings') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!input.path) return json(res, 400, { error: t('Falta el parámetro path.') });
    try {
      deleteRecording(input.path, input.outputDir || null);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/recordings/set-dir  { dir } — mismo criterio que /api/clips/set-dir.
  if (req.method === 'POST' && url.pathname === '/api/recordings/set-dir') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    setRecordingsDir(typeof input.dir === 'string' ? input.dir : null);
    return json(res, 200, { ok: true });
  }

  // GET /api/recordings/orphans?dir=  → .ts que quedaron sin remuxear a .mp4 (crash,
  // cierre forzado de la app, o falla del remux automático). Ver listOrphanRecordings().
  if (req.method === 'GET' && url.pathname === '/api/recordings/orphans') {
    const outputDir = url.searchParams.get('dir') || null;
    try {
      const { dir, files } = listOrphanRecordings(outputDir);
      return json(res, 200, { dir, files });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/recordings/convert  { path, outputDir? } — remuxea un .ts huérfano a .mp4
  // a pedido del usuario. Mismo guard de seguridad que DELETE /api/recordings.
  if (req.method === 'POST' && url.pathname === '/api/recordings/convert') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!input.path) return json(res, 400, { error: t('Falta el parámetro path.') });
    try {
      const mp4Path = await convertOrphanRecording(input.path, input.outputDir || null);
      return json(res, 200, { ok: true, path: mp4Path });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/clips/open  { path, reveal? }  → abre una carpeta, o revela un archivo
  // puntual en el explorador nativo (solo Electron).
  // CN-003: a diferencia de deleteClip/deleteRecording/convertOrphanRecording, este era
  // el único endpoint de archivos sin containment check — shell.openPath() en un path
  // arbitrario ABRE (y para un ejecutable, corre) lo que sea. Acepta: la carpeta de clips
  // o grabaciones exacta (para "abrir carpeta"), o un archivo DENTRO de alguna de las dos
  // (para "revelar clip puntual") — nada fuera de esas dos carpetas.
  if (req.method === 'POST' && url.pathname === '/api/clips/open') {
    let input;
    try { input = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!input.path) return json(res, 400, { error: 'Falta path.' });
    const resolved = path.resolve(input.path);
    const clipsDir = path.resolve(resolveClipsDir(input.outputDir));
    const recordingsDir = path.resolve(resolveRecordingsDir(input.outputDir));
    const isAllowedDir = resolved === clipsDir || resolved === recordingsDir;
    const isAllowedFile = path.dirname(resolved) === clipsDir || path.dirname(resolved) === recordingsDir;
    if (!isAllowedDir && !isAllowedFile) {
      return json(res, 400, { error: t('Ruta fuera de la carpeta de clips.') });
    }
    try {
      const { shell } = await import('electron');
      if (input.reveal) {
        shell.showItemInFolder(resolved);
      } else {
        const err = await shell.openPath(resolved);
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

// CN-001 (parte 1/2): el gate de token de abajo solo exige auth para requests NO-loopback
// — pero el browser de la propia víctima, con una pestaña abierta en cualquier página
// mientras Muxlyve corre, SÍ pega desde loopback (127.0.0.1). Sin esto, esa pestaña puede
// blind-POSTear cualquier endpoint que cambia estado (agregar un destino RTMP, mandar
// mensajes de chat como el streamer, etc.) sin ninguna autenticación. Un fetch() cross-
// origin SIEMPRE manda el header Origin — clientes no-browser (curl, el plugin de Stream
// Deck) normalmente no lo mandan, así que no se ven afectados.
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true; // sin Origin: cliente no-browser, o navegación same-origin
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

// CN-019: comparación en tiempo constante — un !== normal corta apenas encuentra el primer
// byte distinto, filtrando por timing cuánto del token adivinó un atacante. Hashea ambos
// lados primero porque timingSafeEqual exige buffers del MISMO largo, y `got` es lo que
// mande el cliente (largo arbitrario).
function safeTokenEqual(got, expected) {
  if (!got) return false;
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function startPanel(port, config = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    try {
      if (STATE_CHANGING_METHODS.has(req.method) && !originAllowed(req, port)) {
        return json(res, 403, { error: t('Origen no permitido.') });
      }
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
        if (!safeTokenEqual(got, expected)) {
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
      // Config del ingest (URL/clave/preview) — streamKey/flvUrl se recalculan de
      // settings.json en cada pedido (no vienen del snapshot de arranque) para que un
      // cambio de clave desde el panel se vea sin reiniciar la app.
      if (req.method === 'GET' && url.pathname === '/api/config') {
        const settings = loadSettings();
        return json(res, 200, {
          rtmpUrl: config.rtmpUrl || '',
          lanRtmpUrl: config.lanRtmpUrl || '',
          lanIp: config.lanIp || null,
          rtmpPort: config.rtmpPort || null,
          streamKey: settings.streamKey,
          flvUrl: config.httpPort ? `http://localhost:${config.httpPort}/live/${settings.streamKey}.flv` : '',
          version: config.version || '0.0.0',
          panelToken: process.env.ALLOW_LAN_PANEL === 'true' ? getOrCreatePanelToken() : null,
          chatCommandsEnabled: settings.chatCommandsEnabled,
          discordWebhooks: settings.discordWebhooks,
          telegramBots: settings.telegramBots,
          liveMessage: settings.liveMessage || '',
        });
      }

      // POST /api/stream-key { streamKey } — cambia la clave de retransmisión. El valor
      // por defecto (env STREAM_KEY o "mistream") no se toca hasta que el usuario la
      // edite acá — ver settings.js.
      if (req.method === 'POST' && url.pathname === '/api/stream-key') {
        let input;
        try { input = await readBody(req); } catch (err) { return json(res, 400, { error: err.message }); }
        const streamKey = typeof input.streamKey === 'string' ? input.streamKey.trim() : '';
        if (!isValidStreamKey(streamKey)) {
          return json(res, 400, { error: t('La clave debe tener 3-64 caracteres: letras, números, guion o guion bajo.') });
        }
        saveSettings({ streamKey });
        return json(res, 200, { ok: true, streamKey });
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname === '/flv.min.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        return res.end(FLV_JS);
      }
      if (url.pathname === '/panel.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        // Por translateHtml() igual que el HTML — hoy este CSS no tiene texto traducible
        // (solo glifos decorativos ▸/▾ en content:), pero si algún día se le agrega algo
        // visible, ya queda cubierto sin acordarse de este archivo aparte.
        return res.end(translateHtml(PANEL_CSS));
      }
      if (url.pathname === '/chat-window.css' || url.pathname === '/chat-overlay.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        return res.end(translateHtml(url.pathname === '/chat-window.css' ? CHAT_WINDOW_CSS : CHAT_OVERLAY_CSS));
      }
      if (url.pathname === '/chat-window.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        return res.end(translateHtml(CHAT_WINDOW_JS));
      }
      if (url.pathname === '/panel-client.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        return res.end(translateHtml(PANEL_CLIENT_JS));
      }
      if (url.pathname === '/chat-render.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        return res.end(translateHtml(CHAT_RENDER_JS));
      }
      if (url.pathname === '/logo-muxlyve.svg' || url.pathname === '/logo-muxlyve-light.svg' || url.pathname === '/icon-muxlyve.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
        if (url.pathname === '/icon-muxlyve.svg') return res.end(ICON_SVG);
        return res.end(url.pathname === '/logo-muxlyve-light.svg' ? LOGO_SVG_LIGHT : LOGO_SVG);
      }
      if (url.pathname === '/connections.svg' || url.pathname === '/video-off.svg' || url.pathname === '/chat.svg' || url.pathname === '/webhook.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
        if (url.pathname === '/connections.svg') return res.end(CONNECTIONS_SVG);
        if (url.pathname === '/video-off.svg') return res.end(VIDEO_OFF_SVG);
        if (url.pathname === '/webhook.svg') return res.end(WEBHOOK_SVG);
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
<!-- CN-024: defensa en profundidad — no hay ningún XSS reflejado conocido hoy (el chat
     renderiza con createTextNode, no innerHTML), pero si alguna vez aparece uno, esto
     limita el daño. 'unsafe-inline' en script/style es necesario porque TODO el JS/CSS
     de este panel vive inline en este mismo archivo (sin bundler, sin nonces) — sigue
     bloqueando cualquier script/estilo cargado desde un host externo. connect-src incluye
     localhost:* porque el preview HTTP-FLV (flv.js) pega a un puerto distinto del panel
     (HTTP_PORT, no PANEL_PORT) en el mismo host. media-src incluye blob: porque flv.js NO
     pone la url del stream directo en <video>.src — arma un MediaSource, lo vuelca a un
     blob: vía createObjectURL(), y ESO es lo que carga el <video>. Sin blob: acá, el CSP
     lo bloqueaba en silencio y la previsualización quedaba en negro (aunque el audio/video
     grabado en disco, que no pasa por este <video>, seguía bien). -->
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:* http://127.0.0.1:*; frame-src 'none'; object-src 'none'; base-uri 'self'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muxlyve — Panel</title>
<link rel="icon" href="/icon-muxlyve.svg">
<link rel="stylesheet" href="/panel.css">
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
  <div class="win-controls">
    <button onclick="window.msApp && window.msApp.winMinimize()" title="Minimizar">
      <svg width="12" height="12" viewBox="0 0 12 12"><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.4"/></svg>
    </button>
    <button onclick="window.msApp && window.msApp.winToggleMaximize()" title="Maximizar">
      <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
    </button>
    <button class="win-close-btn" onclick="window.msApp && window.msApp.winClose()" title="Cerrar">
      <svg width="12" height="12" viewBox="0 0 12 12"><line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" stroke-width="1.4"/><line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" stroke-width="1.4"/></svg>
    </button>
  </div>
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
          <!-- Grabación completa — archivo único con toda la transmisión, independiente
               del buffer rodante de arriba. Ver startFullRecording() en src/relays.js. -->
          <div class="rec-toggle-row" style="margin-top:.65rem;padding-top:.65rem;border-top:1px solid var(--border)">
            <div>
              <div class="rec-toggle-label">Grabación completa</div>
              <div class="rec-status" id="fullRecStatus">Conecta tu software de streaming para grabar.</div>
            </div>
            <div style="display:flex;align-items:center;gap:.5rem">
              <button class="eye-btn" id="openRecordingsFolderBtn" onclick="openRecordingsFolder()" title="Abrir carpeta de grabaciones">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 4h4.7l2 2H20a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/>
                </svg>
              </button>
              <label class="sys-toggle">
                <input type="checkbox" id="fullRecToggle" disabled onchange="toggleFullRec()">
                <span class="sys-toggle-track"></span>
              </label>
            </div>
          </div>
          <div class="recent-clips" id="recentRecordings" style="display:none">
            <div class="recent-clips-head">Grabaciones recientes</div>
            <div id="recentRecordingsList"></div>
          </div>
        </div>
      </section>
  </div>
  <!-- Sidebar colapsable: destinos -->
  <aside class="sidebar-col" id="sidebarCol">
    <div class="sidebar-inner" id="connPanel" style="display:none">
      <!-- Grilla 2x2, solo íconos + title nativo como tooltip (ver .stream-icon-btn). -->
      <div class="stream-actions-grid">
        <button class="stream-icon-btn" onclick="openStreamInfo()" title="Modificar información del stream">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z"/>
          </svg>
        </button>
        <button class="stream-icon-btn" onclick="openPreflightCheck()" title="Comprobar antes de salir en vivo">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </button>
        <button class="stream-icon-btn" onclick="openScheduleModal()" title="Programar inicio">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
        </button>
        <!-- Mensaje que se manda a los webhooks/bots configurados cuando arranca el
             stream — ver src/notify.js / src/telegram.js. Vive acá, no en Preferencias
             (donde están las URLs/tokens, pestaña Webhooks), porque es algo que se toca
             seguido (cada stream puede querer un mensaje distinto), no un ajuste de una vez. -->
        <button class="stream-icon-btn" onclick="openDiscordMsgModal()" title="Mensaje de aviso al iniciar">
          <span class="icon-mask icon-webhook" style="width:17px;height:17px"></span>
        </button>
      </div>

      <!-- Mismo criterio: agrupa plataformas + destinos personalizados + "Añadir" en un
           solo hijo directo del flex, para que TikTok y "Añadir destino personalizado"
           quedeen tan pegados como las tarjetas entre sí. -->
      <div class="dest-group">
        <!-- Perfiles de destinos — combinaciones guardadas de "qué está prendido", ver
             src/presets.js. Los chips se pintan en runtime, ver renderPresets(). -->
        <div class="preset-block" id="presetBlock">
          <div class="preset-head">
            <span class="preset-label">Perfiles</span>
            <button type="button" class="preset-save-btn" onclick="saveCurrentPreset()" title="Guardar como perfil">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
              Guardar actual
            </button>
          </div>
          <div id="presetChips" class="preset-chips"></div>
        </div>
        <div id="platformList"></div>
        <div id="customList"></div>

        <details class="add" id="addDestDetails">
          <summary class="custom-add-card" style="margin-bottom:0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Añadir destino personalizado
          </summary>
          <div class="add-card">
            <div class="field"><label>Nombre</label><input type="text" id="newName" placeholder="MiPlataforma"></div>
            <div class="row">
              <div class="field"><label>URL (rtmp:// · rtmps:// · srt://)</label><input type="text" id="newUrl" placeholder="rtmp://servidor/app/CLAVE"></div>
              <button class="save" onclick="addDest()">Añadir</button>
            </div>
          </div>
        </details>
      </div>

      <!-- Movido acá desde debajo del preview (antes vivía en .main-col) — es
           información de referencia, no hace falta que esté siempre a la vista. -->
      <div class="pb-block open" id="connInfoBlock">
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
                <!-- "mistream" sigue siendo el default de siempre — esto solo entra en
                     juego si el usuario decide cambiarla, ver POST /api/stream-key. -->
                <details class="bitrate-collapse">
                  <summary>Cambiar clave</summary>
                  <div class="copyrow" style="margin-top:.4rem">
                    <input type="text" id="streamKeyEditInput" placeholder="mistream">
                    <button class="browse-btn" onclick="saveStreamKey()">Guardar</button>
                  </div>
                </details>
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
              <div class="cmd-note" style="margin-top:.6rem;padding-top:.5rem;border-top:1px solid var(--border)">Filtro de palabras — oculta mensajes que las contengan (Twitch y Kick, corre en tu navegador, no depende de su API)</div>
              <input type="text" id="chatKeywordFilterInput" placeholder="separadas por coma" style="width:100%;margin:.3rem 0">
              <button class="browse-btn" style="width:100%" onclick="applyChatKeywordFilter()">Guardar filtro</button>
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
        <button class="prefs-nav-item" data-tab="webhooks" onclick="switchPrefsTab('webhooks')">
          <span class="icon-mask icon-webhook"></span>
          <span>Webhooks</span>
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
            <div style="display:flex;flex-wrap:wrap;gap:.4rem;max-width:220px;justify-content:flex-end">
              <button type="button" class="lang-opt-btn" id="langEsBtn" onclick="setAppLanguage('es')">Español</button>
              <button type="button" class="lang-opt-btn" id="langEnBtn" onclick="setAppLanguage('en')">English</button>
              <button type="button" class="lang-opt-btn" id="langFrBtn" onclick="setAppLanguage('fr')">Français</button>
              <button type="button" class="lang-opt-btn" id="langPtBtn" onclick="setAppLanguage('pt')">Português</button>
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
              <button class="sel" data-dur="60" onclick="setRecDur(60)">1 min</button>
              <button data-dur="300" onclick="setRecDur(300)">5 min</button>
              <button data-dur="600" onclick="setRecDur(600)">10 min</button>
              <button data-dur="900" onclick="setRecDur(900)">15 min</button>
            </div>
          </div>
          <div class="field">
            <label>Carpeta de destino de clips</label>
            <div class="copyrow" style="gap:.4rem;margin-top:.35rem">
              <input type="text" id="clipsDir" placeholder="Predeterminada del sistema"
                     style="font-family:ui-monospace,monospace;font-size:.78rem"
                     oninput="localStorage.setItem('ms_clips_dir', this.value)"
                     onchange="setClipsDirServer(this.value)">
              <button id="browseBtn" class="browse-btn" onclick="browseFolder()" title="Elegir carpeta">…</button>
            </div>
          </div>
          <div class="field">
            <label>Carpeta de grabaciones completas</label>
            <div class="copyrow" style="gap:.4rem;margin-top:.35rem">
              <input type="text" id="recordingsDir" placeholder="Predeterminada del sistema"
                     style="font-family:ui-monospace,monospace;font-size:.78rem"
                     oninput="localStorage.setItem('ms_recordings_dir', this.value)"
                     onchange="setRecordingsDirServer(this.value)">
              <button id="browseRecordingsBtn" class="browse-btn" onclick="browseRecordingsFolder()" title="Elegir carpeta">…</button>
            </div>
          </div>
          <!-- Grabaciones sin convertir — .ts que quedaron sin remuxear a .mp4 (cierre
               forzado de la app, crash, o falla del remux automático). Ver
               listOrphanRecordings()/convertOrphanRecording() en relays.js. Oculto por
               defecto — solo aparece si hay alguno. -->
          <div class="field" id="orphanRecordingsBlock" style="display:none">
            <label>Grabaciones sin convertir</label>
            <div class="pref-desc" style="margin-bottom:.5rem">Quedaron como .ts por un cierre inesperado — convertilas a .mp4 para poder reproducirlas.</div>
            <div id="orphanRecordingsList"></div>
          </div>
          <!-- Comando !clip — ajuste del MOTOR (settings.json), no de Electron, por eso
               vive en esta pestaña (siempre visible) y no en "Sistema" (esa se oculta sin
               la app de escritorio, ver openPrefs()). -->
          <div class="pref-row" style="margin-top:.85rem;padding-top:.85rem;border-top:1px solid var(--border)">
            <div>
              <div>Comando !clip en el chat</div>
              <div class="pref-desc">Mods y vos pueden escribir !clip para guardar un clip del buffer, sin salir del juego.</div>
            </div>
            <label class="sys-toggle">
              <input type="checkbox" id="chatCmdChk" onchange="toggleChatCommands()">
              <span class="sys-toggle-track"></span>
            </label>
          </div>
        </div>
        <div class="prefs-panel" id="prefsWebhooksBlock" data-panel="webhooks">
          <div class="field">
            <label>Webhooks de Discord <span class="pref-desc" style="display:inline">(hasta 3)</span></label>
            <div class="pref-desc" style="margin-bottom:.5rem">Ajustes del canal → Integraciones → Webhooks. Avisa apenas empieza la transmisión — el mensaje se edita aparte, desde el botón de aviso en la pantalla principal.</div>
            <div id="discordWebhooksList"></div>
            <button type="button" class="preset-save-btn" id="addDiscordWebhookBtn" onclick="addDiscordWebhookRow()" style="margin-top:.4rem">+ Añadir webhook</button>
          </div>
          <div class="field" style="margin-top:1.3rem;padding-top:1.1rem;border-top:1px solid var(--border)">
            <label>Bots de Telegram <span class="pref-desc" style="display:inline">(hasta 3)</span></label>
            <div class="pref-desc" style="margin-bottom:.5rem">Creá un bot con @BotFather en Telegram, copiá el token, y el chat ID del canal o grupo donde querés el aviso.</div>
            <div id="telegramBotsList"></div>
            <button type="button" class="preset-save-btn" id="addTelegramBotBtn" onclick="addTelegramBotRow()" style="margin-top:.4rem">+ Añadir bot</button>
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
          <div class="pref-row" style="margin-top:.85rem;padding-top:.85rem;border-top:1px solid var(--border)">
            <div>
              <div>Enviar una idea</div>
              <div class="pref-desc">¿Qué te gustaría ver en Muxlyve?</div>
            </div>
            <button class="lic-manage-btn" onclick="openFeedback()">Feedback</button>
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
<div class="prefs-overlay" id="feedbackOverlay" onclick="if(event.target===this)closeFeedback()">
  <div class="prefs-modal lic-modal">
    <div class="prefs-head">
      <h2>Enviar una idea</h2>
      <button class="prefs-close" onclick="closeFeedback()">✕</button>
    </div>
    <div class="field">
      <label>¿Qué te gustaría ver en Muxlyve?</label>
      <textarea id="feedbackDesc" rows="4" placeholder="Una función, una mejora, lo que sea…"
        style="width:100%;resize:vertical;font-family:inherit;font-size:.85rem;padding:.5rem;
        border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)"></textarea>
    </div>
    <div class="pref-desc" style="margin:.6rem 0 .8rem">
      Se manda con tu versión de la app — no adjunta logs ni datos de tu equipo.
    </div>
    <button id="feedbackSendBtn" onclick="sendFeedback()" style="width:100%">Enviar idea</button>
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
  <div class="prefs-modal" style="width:480px">
    <div class="prefs-head">
      <h2 id="updaterTitle">Actualización</h2>
      <button class="prefs-close" onclick="closeUpdaterModal()">✕</button>
    </div>
    <p id="updaterMessage" style="margin:0 0 .5rem;font-size:.9rem"></p>
    <p id="updaterDetail" class="pref-desc" style="margin:0 0 1rem"></p>
    <!-- Novedades — releaseNotes del release de GitHub (ver electron/updater.js). Oculto
         si el release no trae texto. Colapsado por defecto, no invasivo. -->
    <div class="pb-block" id="updaterNotesBlock" style="display:none;margin-bottom:1rem">
      <div class="pb-head" onclick="toggleUpdaterNotes()">
        <i class="pb-chevron">&#9654;</i>
        <span class="pb-head-name">Novedades de esta versión</span>
      </div>
      <div class="pb-body"><div class="pb-body-inner">
        <p id="updaterNotesText" style="margin:0;font-size:.82rem;white-space:pre-wrap;color:var(--muted);max-height:38vh;overflow-y:auto"></p>
      </div></div>
    </div>
    <div id="updaterProgressBox" style="display:none">
      <div class="upd-progress-track"><div class="upd-progress-fill" id="updaterProgressFill"></div></div>
      <p class="upd-progress-text" id="updaterProgressText"></p>
    </div>
    <div id="updaterButtons" style="display:flex;flex-direction:column;gap:.5rem"></div>
  </div>
</div>

<!-- Confirmación propia — reemplaza confirm() nativo del navegador (blanco, sin estilo
     propio posible, se ve fuera de lugar en Mac/Windows). Contenido se llena en runtime,
     ver showConfirm() en el script del panel. -->
<div class="prefs-overlay" id="confirmOverlay" onclick="if(event.target===this)resolveConfirm(false)">
  <div class="prefs-modal" style="width:380px">
    <div class="prefs-head">
      <h2 id="confirmTitle">Confirmar</h2>
      <button class="prefs-close" onclick="resolveConfirm(false)">✕</button>
    </div>
    <p id="confirmMessage" style="margin:0 0 1rem;font-size:.9rem"></p>
    <div class="about-btn-row">
      <button class="about-close-btn" onclick="resolveConfirm(false)">Cancelar</button>
      <button class="lic-danger-btn" id="confirmOkBtn" style="width:auto;flex:1" onclick="resolveConfirm(true)"></button>
    </div>
  </div>
</div>

<!-- Prompt propio — reemplaza prompt() nativo del navegador, mismo motivo que
     confirmOverlay arriba. Contenido se llena en runtime, ver showPrompt(). -->
<div class="prefs-overlay" id="promptOverlay" onclick="if(event.target===this)resolvePrompt(null)">
  <div class="prefs-modal" style="width:380px">
    <div class="prefs-head">
      <h2 id="promptTitle">Confirmar</h2>
      <button class="prefs-close" onclick="resolvePrompt(null)">✕</button>
    </div>
    <div class="field">
      <input type="text" id="promptInput" onkeydown="if(event.key==='Enter')resolvePrompt($('#promptInput').value)">
    </div>
    <div class="about-btn-row" style="margin-top:1rem">
      <button class="about-close-btn" onclick="resolvePrompt(null)">Cancelar</button>
      <button class="browse-btn" style="flex:1" onclick="resolvePrompt($('#promptInput').value)">Guardar</button>
    </div>
  </div>
</div>

<!-- Mensaje de aviso — compartido entre Discord y Telegram (los webhooks/tokens viven en
     Preferencias → Webhooks, eso se toca una vez; esto se toca seguido, cada stream puede
     querer un texto distinto, por eso tiene su propio botón de acceso rápido). Ver
     src/notify.js / src/telegram.js. -->
<div class="prefs-overlay" id="discordMsgOverlay" onclick="if(event.target===this)closeDiscordMsgModal()">
  <div class="prefs-modal" style="width:460px">
    <div class="prefs-head">
      <h2>Mensaje de aviso</h2>
      <button class="prefs-close" onclick="closeDiscordMsgModal()">✕</button>
    </div>
    <p class="pref-desc" style="margin:0 0 .6rem">Se manda a los webhooks de Discord y bots de Telegram configurados (Preferencias → Webhooks) apenas empieza la transmisión. Discord admite su formato (**negrita**, *itálica*, enlaces) — Telegram lo muestra como texto plano.</p>
    <div class="field">
      <textarea id="discordMsgInput" rows="5" maxlength="2000" oninput="updateDiscordMsgCount()"
        placeholder="🔴 ¡La transmisión empezó!"
        style="width:100%;resize:vertical;font-family:inherit;font-size:.85rem;padding:.5rem;
        border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)"></textarea>
      <div class="pref-desc" style="text-align:right;margin-top:.25rem" id="discordMsgCount">0 / 2000</div>
    </div>
    <div class="about-btn-row">
      <button class="about-close-btn" onclick="testAllChannelsUi()">Probar</button>
      <button class="browse-btn" style="flex:1" onclick="saveDiscordMsgModal()">Guardar</button>
    </div>
  </div>
</div>

<!-- Resumen post-stream — se llena en runtime con los acumuladores de sesión, ver
     showSessionSummary()/resetSessionStats() en el script del panel. -->
<div class="prefs-overlay" id="summaryOverlay" onclick="if(event.target===this)closeSessionSummary()">
  <div class="prefs-modal" style="width:380px">
    <div class="prefs-head">
      <h2>Resumen del stream</h2>
      <button class="prefs-close" onclick="closeSessionSummary()">✕</button>
    </div>
    <div id="summaryBody" style="display:flex;flex-direction:column;gap:.5rem;font-size:.9rem;margin-bottom:1rem"></div>
    <button class="browse-btn" style="width:100%" onclick="closeSessionSummary()">Cerrar</button>
  </div>
</div>

<!-- Comprobación previa a salir en vivo — se llena en runtime, ver openPreflightCheck()
     en el script del panel. -->
<div class="prefs-overlay" id="preflightOverlay" onclick="if(event.target===this)closePreflight()">
  <div class="prefs-modal" style="width:380px">
    <div class="prefs-head">
      <h2>Comprobación previa</h2>
      <button class="prefs-close" onclick="closePreflight()">✕</button>
    </div>
    <div id="preflightBody" style="display:flex;flex-direction:column;gap:.6rem;font-size:.88rem"></div>
  </div>
</div>

<!-- Programar inicio — activa destinos elegidos a una hora futura, ver
     confirmSchedule()/runScheduledStart() en el script del panel. -->
<div class="prefs-overlay" id="scheduleOverlay" onclick="if(event.target===this)closeScheduleModal()">
  <div class="prefs-modal" style="width:380px">
    <div class="prefs-head">
      <h2>Programar inicio</h2>
      <button class="prefs-close" onclick="closeScheduleModal()">✕</button>
    </div>
    <p class="pref-desc" style="margin:0 0 .75rem">Cada destino puede tener su propia hora — marcalo y elegí cuándo se activa solo, igual que si le dieras al toggle a mano. Desmarcalo para cancelar su programación. Igual esperan a que tu software de streaming se conecte para empezar a reenviar.</p>
    <div id="scheduleDestList" style="display:flex;flex-direction:column;gap:.65rem;margin-bottom:.75rem"></div>
    <button class="browse-btn" style="width:100%" onclick="confirmSchedule()">Programar</button>
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
<script src="/chat-render.js"></script>
<script src="/panel-client.js"></script>
</body>
</html>`;

// Página independiente y minimalista para la ventana de chat "flotante" — separada de
// PANEL_HTML a propósito para no meter otro backtick dentro de ese template gigante.
export const CHAT_WINDOW_HTML = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<!-- CN-024 — ver el comentario equivalente en PANEL_HTML. Sin flv.js acá, connect-src
     no necesita el localhost:* extra. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'">
<title>Muxlyve — Chat</title>
<link rel="stylesheet" href="/chat-window.css">
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
      <div class="cmd-note">¿Quieres mostrar el chat en tu programa de transmisión (OBS, Streamlabs, etc.)? Abre el panel principal de Muxlyve → ícono "Conexiones" → "Información de conexión" → "Conexión del chat" para copiar la URL.</div>
    </div>
  </div>
  <div class="chat-win-controls">
    <button onclick="window.msApp && window.msApp.winMinimize()" title="Minimizar">
      <svg width="11" height="11" viewBox="0 0 12 12"><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.4"/></svg>
    </button>
    <button class="win-close-btn" onclick="window.msApp && window.msApp.winClose()" title="Cerrar">
      <svg width="11" height="11" viewBox="0 0 12 12"><line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" stroke-width="1.4"/><line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" stroke-width="1.4"/></svg>
    </button>
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
<script src="/chat-render.js"></script>
<script src="/chat-window.js"></script>
</body>
</html>`;

// Fuente de navegador para OBS. Sin electron/preload — corre dentro del proceso Chromium
// embebido de OBS, así que solo puede depender de HTTP/SSE, igual que CHAT_WINDOW_HTML.
// Duplica el render de mensajes a propósito (mismo motivo que ese: documento aparte, sin
// script compartido) pero recorta todo lo interactivo — es solo para mostrar en escena.
export const CHAT_OVERLAY_HTML = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<!-- CN-024 — ver el comentario equivalente en PANEL_HTML. Esta página es la que carga
     OBS como fuente de Navegador (embebido, no un browser normal), pero el mismo criterio
     de defensa en profundidad aplica igual. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'">
<title>Muxlyve — Chat overlay</title>
<link rel="stylesheet" href="/chat-overlay.css">
</head>
<body>
<div id="box"></div>
<script src="/chat-render.js"></script>
<script>
  // PLATFORM_ICON_GLYPHS/COLORS, platformIconSvg, BROADCASTER_BADGE_SVG,
  // renderMessageBody vienen de /chat-render.js (compartido con el panel y el popout).
  function append(msg) {
    var box = document.getElementById('box');
    var row = document.createElement('div');
    row.className = 'row';
    var iconHtml = platformIconSvg(msg.platform, 14, 4);
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
