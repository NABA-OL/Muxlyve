/*
 * Propiedad de BlacKraken Solutions <blackraken.com>
 * Desarrollado por: NABAOL
 * Fecha de creación: 2026-07-01
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
// Chat unificado — fase 1: solo Twitch. Lee el chat vía IRC-WebSocket con un nick anónimo
// (justinfanNNNNN) — Twitch permite lectura pública sin autenticación, no requiere el
// OAuth del usuario para esto en absoluto, solo su channel login para saber a qué unirse.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { loadSettings } from './settings.js';
import { translateText } from './translate.js';

export const chatBus = new EventEmitter();

const MAX_HISTORY = 100;
const history = [];

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 2000;
const MAX_RECONNECT_DELAY = 30000;
let currentLogin = null;
let manuallyStopped = true;

// Traducción de chat (opt-in, ver chatTranslateEnabled en settings.js). Solo Twitch trae
// un id real (tag IRCv3) — Kick/YouTube no, así que acá se le pone uno sintético a
// cualquiera que no traiga, para poder correlacionar la traducción (que llega un ratito
// después, ver abajo) con la fila ya pintada en el cliente.
let nextSyntheticId = 1;
const SUPPORTED_TRANSLATE_LANGS = new Set(['es', 'en', 'fr', 'pt']);
function pushMessage(rawMsg) {
  const msg = rawMsg.id ? rawMsg : { ...rawMsg, id: 'm' + nextSyntheticId++ };
  history.push(msg);
  if (history.length > MAX_HISTORY) history.shift();
  chatBus.emit('message', msg);
  maybeTranslate(msg);
}

// Fire-and-forget a propósito — la traducción NUNCA debe atrasar ni poder tumbar el chat
// en vivo (ver disclaimer completo del riesgo en src/translate.js). Si tarda o falla, el
// mensaje ya se mostró igual, sin traducción — no hay nada que "reintentar" ni que
// bloquee. Emite un evento aparte ('message-translated') en vez de re-emitir el mensaje
// completo: el cliente solo necesita el id + el texto traducido para anotar la fila que
// ya está pintada.
function maybeTranslate(msg) {
  if (!msg.message) return;
  const target = process.env.APP_LANG;
  const targetLang = SUPPORTED_TRANSLATE_LANGS.has(target) ? target : 'es';
  if (!loadSettings().chatTranslateEnabled) return;
  translateText(msg.message, targetLang)
    .then((result) => { if (result) chatBus.emit('message-translated', { id: msg.id, translated: result.translated }); })
    .catch(() => {});
}

export function getHistory() {
  return history.slice();
}

function parseTags(tagStr) {
  const tags = {};
  for (const part of tagStr.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    tags[part.slice(0, eq)] = part.slice(eq + 1).replace(/\\s/g, ' ');
  }
  return tags;
}

// tag emotes de IRCv3: "emoteId:start-end,start-end/emoteId2:start-end" — start/end son
// índices inclusivos dentro del mensaje. Se normaliza a {start, end(exclusivo), url} para
// que el renderer (panel + ventana externa) no tenga que saber nada de Twitch en particular.
function parseTwitchEmotes(tagValue) {
  if (!tagValue) return [];
  const out = [];
  for (const part of tagValue.split('/')) {
    const [id, ranges] = part.split(':');
    if (!id || !ranges) continue;
    for (const range of ranges.split(',')) {
      const [start, end] = range.split('-').map(Number);
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      out.push({ start, end: end + 1, url: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0` });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function handleLine(line) {
  if (!line) return;
  if (line.startsWith('PING')) {
    try { ws.send('PONG :tmi.twitch.tv'); } catch {}
    return;
  }
  // IRCv3 con tags: "@tag1=val1;tag2=val2 :nick!user@host PRIVMSG #canal :mensaje"
  let tags = {};
  let rest = line;
  if (line.startsWith('@')) {
    const sp = line.indexOf(' ');
    tags = parseTags(line.slice(1, sp));
    rest = line.slice(sp + 1);
  }
  const m = rest.match(/^:(\S+)!\S+ PRIVMSG #\S+ :(.*)$/);
  if (!m) return;
  const [, nick, text] = m;
  pushMessage({
    platform: 'twitch',
    username: tags['display-name'] || nick,
    message: text,
    color: tags.color || null,
    emotes: parseTwitchEmotes(tags.emotes),
    // El nick de IRC de Twitch siempre es el login en minúsculas (aunque el display-name
    // tenga mayúsculas/acentos) — currentLogin viene de la misma fuente (Helix), comparación exacta.
    isBroadcaster: !!currentLogin && nick.toLowerCase() === currentLogin.toLowerCase(),
    // Twitch manda el tag "mod" (1/0) y además el badge moderator/broadcaster en tags.badges
    // — se acepta cualquiera de las dos formas, por si algún cliente IRC viejo no manda una.
    isMod: isModFromTwitchTags(tags),
    // id: UUID del mensaje (tag IRCv3) — lo exige /helix/chat/messages/pin como message_id.
    id: tags.id || null,
    // user-id: ID numérico de Twitch del autor (tag IRCv3, siempre presente en PRIVMSG) —
    // lo exige /helix/moderation/bans como user_id para timeout/ban (ver Fase 5,
    // docs/PLAN_FEATURES_LOTE2.md). No confundir con el "id" de arriba (ese es del
    // MENSAJE, no del usuario).
    userId: tags['user-id'] || null,
    timestamp: Date.now(),
  });
}

// Ver comentario en handleLine — moderador si el tag "mod" lo dice, o si el badge de
// moderador/broadcaster está en la lista de badges del mensaje.
function isModFromTwitchTags(tags) {
  if (tags.mod === '1') return true;
  const badges = tags.badges || '';
  return badges.includes('moderator/') || badges.includes('broadcaster/');
}

function connect() {
  if (manuallyStopped || !currentLogin) return;
  const anonNick = 'justinfan' + Math.floor(10000 + Math.random() * 89999);
  ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

  ws.onopen = () => {
    reconnectDelay = 2000;
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send('PASS SCHMOOPIIE');
    ws.send(`NICK ${anonNick}`);
    ws.send(`JOIN #${currentLogin.toLowerCase()}`);
    console.log(`[chat] Twitch: conectado al canal #${currentLogin}`);
  };
  ws.onmessage = (event) => {
    for (const line of String(event.data).split('\r\n')) handleLine(line);
  };
  ws.onclose = () => {
    ws = null;
    if (!manuallyStopped) scheduleReconnect();
  };
  ws.onerror = () => { /* onclose se dispara después — la reconexión se maneja ahí */ };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

export function startTwitchChat(login) {
  if (!login) return;
  if (!manuallyStopped && currentLogin === login) return; // ya conectado a ese canal
  stopTwitchChat();
  manuallyStopped = false;
  currentLogin = login;
  connect();
}

export function stopTwitchChat() {
  manuallyStopped = true;
  clearTimeout(reconnectTimer);
  currentLogin = null;
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

// ── YouTube Live Chat (fase 2) ──────────────────────────────────────────────
// A diferencia de Twitch (IRC anónimo, sin auth), YouTube no tiene lectura pública —
// usa el token OAuth ya obtenido (scope youtube.readonly cubre liveBroadcasts.list y
// liveChatMessages.list) y polling, que es como exige la API de YouTube Data v3 — no
// hay WebSocket real. Costo de cuota: liveChatMessages.list cuesta 5 unidades sobre
// las 10,000/día por defecto del proyecto de Google Cloud — con varios streamers
// usando la misma app en simultáneo comparten esa cuota (viene del mismo client_id
// bundleado en el binario). Se respeta el pollingIntervalMillis que la propia API
// devuelve en cada respuesta en vez de un intervalo fijo propio.
let ytTimer = null;
let ytStopped = true;
let ytGetToken = null;
let ytLiveChatId = null;
let ytPageToken = null;
let ytBackoff = 5000;
const YT_MIN_INTERVAL = 4000;
const YT_MAX_BACKOFF = 60000;

async function ytFetch(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

async function findActiveLiveChatId(token) {
  const { ok, data } = await ytFetch(
    'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all',
    token,
  );
  if (!ok) return null;
  return data.items?.[0]?.snippet?.liveChatId || null;
}

function scheduleYtPoll(delay) {
  clearTimeout(ytTimer);
  if (!ytStopped) ytTimer = setTimeout(ytPollLoop, delay);
}

async function ytPollLoop() {
  if (ytStopped) return;
  try {
    const token = await ytGetToken();
    if (!token) { scheduleYtPoll(10000); return; }

    if (!ytLiveChatId) {
      ytLiveChatId = await findActiveLiveChatId(token);
      if (!ytLiveChatId) { scheduleYtPoll(15000); return; } // aún no hay transmisión activa en YouTube
      console.log('[chat] YouTube: liveChatId encontrado, arrancando polling.');
    }

    const params = new URLSearchParams({ liveChatId: ytLiveChatId, part: 'snippet,authorDetails' });
    if (ytPageToken) params.set('pageToken', ytPageToken);
    const { ok, status, data } = await ytFetch(
      `https://www.googleapis.com/youtube/v3/liveChat/messages?${params}`,
      token,
    );

    if (!ok) {
      if (status === 404) { ytLiveChatId = null; ytPageToken = null; } // el chat/transmisión terminó
      ytBackoff = Math.min(ytBackoff * 2, YT_MAX_BACKOFF);
      scheduleYtPoll(ytBackoff);
      return;
    }
    ytBackoff = 5000;
    ytPageToken = data.nextPageToken || ytPageToken;
    for (const item of data.items || []) {
      pushMessage({
        platform: 'youtube',
        username: item.authorDetails?.displayName || '???',
        message: item.snippet?.displayMessage || '',
        color: null,
        // El `part=snippet,authorDetails` de arriba ya trae isChatModerator/isChatOwner
        // sin ampliar ningún scope — a diferencia de Twitch/Kick no hace falta un helper
        // aparte, YouTube ya entrega el booleano listo.
        isMod: !!(item.authorDetails?.isChatModerator || item.authorDetails?.isChatOwner),
        // channelId del autor — es el "userId" que pide liveChatBans.insert para banear
        // (ver banYoutubeUser en electron/oauth.js). isChatOwner = el propio streamer, para
        // no ofrecer "banearse a sí mismo" en la UI (mismo criterio que isBroadcaster de
        // Twitch).
        userId: item.authorDetails?.channelId || null,
        isBroadcaster: !!item.authorDetails?.isChatOwner,
        timestamp: Date.now(),
      });
    }
    scheduleYtPoll(Math.max(data.pollingIntervalMillis || 8000, YT_MIN_INTERVAL));
  } catch (err) {
    console.error('[chat] YouTube: error en polling —', err.message);
    ytBackoff = Math.min(ytBackoff * 2, YT_MAX_BACKOFF);
    scheduleYtPoll(ytBackoff);
  }
}

// getToken: función async provista por el llamador (oauth.js) que devuelve un
// access_token vigente (refrescándolo si hace falta) o null si no hay sesión.
// Se pasa como parámetro en vez de importar oauth.js aquí para no crear un import
// circular (oauth.js ya importa este módulo para start/stopTwitchChat).
export function startYoutubeChat(getToken) {
  if (!ytStopped) return; // ya corriendo
  ytStopped = false;
  ytGetToken = getToken;
  ytLiveChatId = null;
  ytPageToken = null;
  ytBackoff = 5000;
  ytPollLoop();
}

export function stopYoutubeChat() {
  ytStopped = true;
  clearTimeout(ytTimer);
  ytTimer = null;
  ytLiveChatId = null;
  ytPageToken = null;
}

// El mismo liveChatId que ya está sondeando ytPollLoop — reusarlo (en vez de que
// banYoutubeUser/sendYoutubeMessage en oauth.js vuelvan a pedirlo) evita una llamada extra
// a la API y garantiza que apuntan al chat que el streamer está viendo en pantalla ahora
// mismo, no a uno recién resuelto que podría ya no ser el activo.
export function getYoutubeLiveChatId() {
  return ytLiveChatId;
}

// ── Kick chat (fase 3) ───────────────────────────────────────────────────────
// Chat público de Kick, SIN OAuth — igual que Twitch, no como YouTube (el token que se
// obtiene al conectar Kick es solo para saber el slug del canal, no se usa acá). Esto NO es
// una API oficial documentada por Kick — es el protocolo que usa su propio sitio web,
// reverse-engineered, a diferencia de la IRC de Twitch que sí es pública y estable.
//
// Historia: hasta 2026-10 iba por Pusher (app key fijo). Kick lo migró a Centrifugo y el
// app key viejo devuelve 4001 "not in this cluster". Flujo actual (verificado 2026-10-13
// contra canales reales y contra el JS de kick.com, chunk con "realtime/connection"):
//   1. kick.com/api/v2/channels/<slug>  → id de canal + id de chatroom (Cloudflare: solo
//      pasa con el fetch de Chromium que inyecta electron/oauth.js, ver setKickFetchImpl).
//   2. POST web.kick.com/api/v1/realtime/channels/<channelId>/chat/connection
//      { client:{id:<uuid>,type:'web'}, capabilities:{accepted_providers:[...]} }
//      → { data:{ connections:[{ provider:'centrifugo', credentials:{ url } }] } }
//   3. POST web.kick.com/api/v1/realtime/auth/connection { client_id } → JWT anónimo
//      (vive ~45 min: el servidor avisa `ttl` y hay que mandar un `refresh`).
//   4. WebSocket al `url`, protocolo JSON de Centrifugo: connect{token} → subscribe
//      {channel:'chatrooms.<chatroomId>.v2'} (el id de CHATROOM, no el de canal) → llegan
//      push.pub.data = { event:'App\Events\ChatMessageEvent', data:'<json string>' }.
//      El servidor manda `{}` cada ~25 s y exige responder `{}` (pong:true).
// Si deja de llegar chat: repetir el procedimiento de arriba mirando la pestaña Network de
// kick.com en un canal en vivo (filtro "realtime") y comparar con este flujo.
const KICK_WEB_API = 'https://web.kick.com/api/v1/realtime';
const KICK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const KICK_TOKEN_REFRESH_LEAD_S = 60; // refrescar el JWT un minuto antes de que expire
const KICK_SERVER_PING_SLACK_S = 10;  // tolerancia sobre el ping del servidor antes de dar la conexión por muerta

let kickWs = null;
let kickReconnectTimer = null;
let kickWatchdogTimer = null;
let kickRefreshTimer = null;
let kickReconnectDelay = 2000;
let kickSlug = null;
let kickStopped = true;
// El slug del canal (para el lookup de chatroom) no siempre es igual al username que
// Kick muestra en el chat (mayúsculas/formato distinto) — se guarda aparte para comparar
// bien contra sender.username y marcar isBroadcaster.
let kickBroadcasterName = null;

// fetch inyectable — por defecto el global de Node, pero ese SIEMPRE recibe 403 de
// Cloudflare en kick.com/api/v2 (probado: bloquea aunque mandes headers de navegador
// completos, es huella de TLS/HTTP, no de headers). electron/oauth.js reemplaza esto por
// electron.net.fetch al arrancar — corre por el stack de red de Chromium, mismo que un
// navegador real, y ese sí pasa. src/ no importa 'electron' directo (debe poder correr
// headless — Docker, npm start) por eso queda como inyección en vez de import fijo.
// (web.kick.com, en cambio, responde bien al fetch global — probado — pero se usa el mismo
// inyectable para no depender de eso.)
let kickFetchImpl = (...args) => fetch(...args);
export function setKickFetchImpl(fn) { kickFetchImpl = fn; }

// Endpoint interno del sitio de Kick (no el oficial de dev.kick.com) — es lo que usa el
// propio frontend de Kick para resolver slug → ids, no hay equivalente en la API pública
// documentada todavía.
async function findKickChannelIds(slug) {
  const r = await kickFetchImpl(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
    headers: { 'User-Agent': KICK_UA, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`lookup de canal falló (status ${r.status})`);
  const d = await r.json();
  const channelId = d.id;
  const chatroomId = d.chatroom?.id;
  if (!channelId || !chatroomId) throw new Error('respuesta sin id de canal/chatroom — ¿cambió el formato?');
  return { channelId, chatroomId };
}

async function kickRealtimePost(path, body) {
  const r = await kickFetchImpl(`${KICK_WEB_API}${path}`, {
    method: 'POST',
    headers: { 'User-Agent': KICK_UA, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} respondió ${r.status}`);
  return r.json();
}

async function fetchKickConnectionToken(clientId) {
  const token = (await kickRealtimePost('/auth/connection', { client_id: clientId })).data?.token;
  if (!token) throw new Error('auth/connection sin token — ¿cambió el formato?');
  return token;
}

// Pide a Kick dónde conectarse y un token anónimo. Solo anunciamos `centrifugo`: es lo que
// habla este cliente — si Kick no puede ofrecerlo, mejor fallar claro que recibir otro proveedor.
async function openKickRealtime(channelId) {
  const clientId = randomUUID();
  const res = await kickRealtimePost(`/channels/${channelId}/chat/connection`, {
    client: { id: clientId, type: 'web' },
    capabilities: { accepted_providers: [{ provider: 'centrifugo' }] },
  });
  const url = res.data?.connections?.find((c) => c.provider === 'centrifugo')?.credentials?.url;
  if (!url) throw new Error('Kick no ofreció el proveedor centrifugo — ¿cambió el protocolo?');
  return { url, clientId, token: await fetchKickConnectionToken(clientId) };
}

// Los nombres de evento/campos documentados por distintas fuentes comunitarias no
// coinciden entre sí (Kick no publica esto oficialmente) — se acepta cualquiera de las
// variantes conocidas en vez de asumir una sola, para no depender de adivinar cuál es
// la vigente hoy.
// Kick mete los emotes como texto plano tipo "[emote:12345:Nombre]" dentro del propio
// mensaje (no como metadata aparte, a diferencia de Twitch) — se detecta con regex y se
// normaliza a la misma forma {start, end, url} que usa Twitch, para que el renderer sea
// uno solo. El span completo del token (corchetes incluidos) se reemplaza por la imagen.
const KICK_EMOTE_RE = /\[emote:(\d+):[^\]]+\]/g;
function parseKickEmotes(text) {
  const out = [];
  let match;
  KICK_EMOTE_RE.lastIndex = 0;
  while ((match = KICK_EMOTE_RE.exec(text))) {
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      url: `https://files.kick.com/emotes/${match[1]}/fullsize`,
    });
  }
  return out;
}

// Un WebSocket de Centrifugo puede juntar varios comandos JSON separados por salto de línea
// en un solo mensaje.
export function parseKickFrames(raw) {
  const out = [];
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* frame corrupto: se ignora */ }
  }
  return out;
}

// Sobre de una publicación ({ event, data }) → mensaje del chat unificado, o null si no es
// un mensaje de chat (borrados, bans, etc. llegan por el mismo canal y no se usan acá).
export function kickEnvelopeToMessage(envelope, broadcasterName) {
  if (envelope?.event !== 'App\\Events\\ChatMessageEvent' && envelope?.event !== 'App\\Events\\ChatMessageSentEvent') return null;
  let payload = envelope.data;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  const text = payload?.content || payload?.message?.message;
  const username = payload?.sender?.username || payload?.user?.username;
  if (!text || !username) return null;
  return {
    platform: 'kick',
    username,
    message: text,
    color: payload.sender?.identity?.color || null,
    emotes: parseKickEmotes(text),
    isBroadcaster: !!broadcasterName && username.toLowerCase() === broadcasterName.toLowerCase(),
    isMod: isModFromKickBadges(payload.sender?.identity?.badges),
    timestamp: Date.now(),
  };
}

// Kick manda los badges como array de objetos { type, ... } — defensivo porque no siempre
// viene (mensajes de sistema, formatos alternativos vistos en la comunidad).
function isModFromKickBadges(badges) {
  if (!Array.isArray(badges)) return false;
  return badges.some((b) => b?.type === 'moderator' || b?.type === 'broadcaster');
}

function clearKickTimers() {
  clearTimeout(kickWatchdogTimer);
  clearTimeout(kickRefreshTimer);
  kickWatchdogTimer = kickRefreshTimer = null;
}

async function connectKick() {
  if (kickStopped || !kickSlug) return;
  let ids, rt;
  try {
    ids = await findKickChannelIds(kickSlug);
    rt = await openKickRealtime(ids.channelId);
  } catch (err) {
    console.error('[chat] Kick: no se pudo abrir la conexión en tiempo real —', err.message);
    if (!kickStopped) scheduleKickReconnect();
    return;
  }
  if (kickStopped) return;

  const sock = new WebSocket(rt.url);
  kickWs = sock;
  const channel = `chatrooms.${ids.chatroomId}.v2`;
  const pending = new Map(); // id de comando → 'connect' | 'subscribe' | 'refresh'
  let cmdId = 0;
  const command = (kind, body) => {
    pending.set(++cmdId, kind);
    sock.send(JSON.stringify({ id: cmdId, [kind]: body }));
  };
  // Un socket viejo (reemplazado por stopKickChat→startKickChat) no debe tocar el estado del nuevo.
  const onClosed = () => {
    if (kickWs !== sock) return;
    kickWs = null;
    clearKickTimers();
    if (!kickStopped) scheduleKickReconnect();
  };
  const dropConnection = () => { try { sock.close(); } catch {} onClosed(); };
  // Sin ningún frame (ni el ping cada ~25 s) la conexión está muerta aunque el socket siga "abierto".
  const armWatchdog = (pingSecs) => {
    clearTimeout(kickWatchdogTimer);
    kickWatchdogTimer = setTimeout(() => {
      console.warn('[chat] Kick: el servidor dejó de responder, reconectando…');
      dropConnection();
    }, (pingSecs + KICK_SERVER_PING_SLACK_S) * 1000);
  };
  const scheduleTokenRefresh = (ttlSecs) => {
    clearTimeout(kickRefreshTimer);
    kickRefreshTimer = setTimeout(async () => {
      try {
        command('refresh', { token: await fetchKickConnectionToken(rt.clientId) });
      } catch (err) {
        console.warn('[chat] Kick: no se pudo renovar el token, reconectando —', err.message);
        dropConnection();
      }
    }, Math.max(ttlSecs - KICK_TOKEN_REFRESH_LEAD_S, 30) * 1000);
  };

  let pingSecs = 25;
  armWatchdog(pingSecs);
  sock.onopen = () => command('connect', { token: rt.token, name: 'muxlyve' });
  sock.onmessage = (event) => {
    if (kickWs !== sock) return;
    armWatchdog(pingSecs);
    for (const m of parseKickFrames(event.data)) {
      if (Object.keys(m).length === 0) { sock.send('{}'); continue; } // ping del servidor → pong
      if (m.error) {
        console.error(`[chat] Kick: el servidor rechazó "${pending.get(m.id) ?? 'comando'}" (código ${m.error.code}: ${m.error.message})`);
        dropConnection(); // se reconecta con token y conexión nuevos (con backoff)
        return;
      }
      if (m.connect) {
        if (m.connect.ping) pingSecs = m.connect.ping;
        if (m.connect.expires) scheduleTokenRefresh(m.connect.ttl);
        command('subscribe', { channel });
      } else if (m.refresh) {
        if (m.refresh.expires) scheduleTokenRefresh(m.refresh.ttl);
      } else if (m.subscribe) {
        kickReconnectDelay = 2000; // recién acá la conexión es útil: se resetea el backoff
        console.log(`[chat] Kick: conectado al canal #${kickSlug} (chatroom ${ids.chatroomId})`);
      } else if (m.push?.pub && m.push.channel === channel) {
        const msg = kickEnvelopeToMessage(m.push.pub.data, kickBroadcasterName);
        if (msg) pushMessage(msg);
      }
    }
  };
  sock.onclose = onClosed;
  sock.onerror = () => { /* onclose se dispara después — la reconexión se maneja ahí */ };
}

function scheduleKickReconnect() {
  clearTimeout(kickReconnectTimer);
  kickReconnectTimer = setTimeout(connectKick, kickReconnectDelay);
  kickReconnectDelay = Math.min(kickReconnectDelay * 2, MAX_RECONNECT_DELAY);
}

export function startKickChat(slug, broadcasterName) {
  if (!slug) return;
  if (!kickStopped && kickSlug === slug) return; // ya conectado a ese canal
  stopKickChat();
  kickStopped = false;
  kickSlug = slug;
  kickBroadcasterName = broadcasterName || null;
  connectKick();
}

export function stopKickChat() {
  kickStopped = true;
  kickBroadcasterName = null;
  clearTimeout(kickReconnectTimer);
  clearKickTimers();
  kickSlug = null;
  const sock = kickWs;
  kickWs = null;
  if (sock) { try { sock.close(); } catch {} }
}
