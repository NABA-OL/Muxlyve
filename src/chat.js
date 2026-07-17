// Desarrollado por BlacKraken Solutions (NABA-OL)
// Chat unificado — fase 1: solo Twitch. Lee el chat vía IRC-WebSocket con un nick anónimo
// (justinfanNNNNN) — Twitch permite lectura pública sin autenticación, no requiere el
// OAuth del usuario para esto en absoluto, solo su channel login para saber a qué unirse.
import { EventEmitter } from 'node:events';

export const chatBus = new EventEmitter();

const MAX_HISTORY = 100;
const history = [];

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 2000;
const MAX_RECONNECT_DELAY = 30000;
let currentLogin = null;
let manuallyStopped = true;

function pushMessage(msg) {
  history.push(msg);
  if (history.length > MAX_HISTORY) history.shift();
  chatBus.emit('message', msg);
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
    timestamp: Date.now(),
  });
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

// ── Kick chat (fase 3) ───────────────────────────────────────────────────────
// Chat público de Kick, SIN OAuth — igual que Twitch, no como YouTube (el token que se
// obtiene al conectar Kick es solo para saber el slug del canal, no se usa acá). Va por
// Pusher (Kick no expone WebSocket propio). Esto NO es una API oficial documentada por
// Kick — es protocolo reverse-engineered por la comunidad, a diferencia de la IRC de
// Twitch que sí es pública y estable. El app key de Pusher puede rotar sin aviso de Kick.
// Si deja de llegar chat: abrir kick.com en vivo, Chrome DevTools → Network → filtro
// "pusher", y copiar el app key nuevo de la URL del WebSocket a KICK_PUSHER_APP_KEY.
const KICK_PUSHER_APP_KEY = '32cbd69e4b950bf97679';
const KICK_WS_URL = `wss://ws-us2.pusher.com/app/${KICK_PUSHER_APP_KEY}?protocol=7&client=js&version=8.4.0&flash=false`;

let kickWs = null;
let kickReconnectTimer = null;
let kickReconnectDelay = 2000;
let kickSlug = null;
let kickStopped = true;

// Endpoint interno del sitio de Kick (no el oficial de dev.kick.com) — es lo que usa el
// propio frontend de Kick para resolver slug → chatroom id, no hay equivalente en la API
// pública documentada todavía. Puede estar detrás de protección Cloudflare; con un
// User-Agent de navegador normal suele pasar.
async function findKickChatroomId(slug) {
  const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'application/json',
    },
  });
  if (!r.ok) throw new Error(`lookup de canal falló (status ${r.status})`);
  const d = await r.json();
  const id = d.chatroom?.id;
  if (!id) throw new Error('respuesta sin chatroom.id — ¿cambió el formato?');
  return id;
}

// Los nombres de evento/campos documentados por distintas fuentes comunitarias no
// coinciden entre sí (Kick no publica esto oficialmente) — se acepta cualquiera de las
// variantes conocidas en vez de asumir una sola, para no depender de adivinar cuál es
// la vigente hoy.
function handleKickPusherEvent(raw) {
  let outer;
  try { outer = JSON.parse(raw); } catch { return; }
  if (outer.event !== 'App\\Events\\ChatMessageEvent' && outer.event !== 'App\\Events\\ChatMessageSentEvent') return;
  let payload;
  try { payload = JSON.parse(outer.data); } catch { return; }
  const text = payload.content || payload.message?.message;
  const username = payload.sender?.username || payload.user?.username;
  if (!text || !username) return;
  pushMessage({
    platform: 'kick',
    username,
    message: text,
    color: payload.sender?.identity?.color || null,
    timestamp: Date.now(),
  });
}

async function connectKick() {
  if (kickStopped || !kickSlug) return;
  let chatroomId;
  try {
    chatroomId = await findKickChatroomId(kickSlug);
  } catch (err) {
    console.error('[chat] Kick: no se pudo resolver el chatroom —', err.message);
    if (!kickStopped) scheduleKickReconnect();
    return;
  }
  if (kickStopped) return;

  kickWs = new WebSocket(KICK_WS_URL);
  kickWs.onopen = () => {
    kickReconnectDelay = 2000;
    kickWs.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: `chatrooms.${chatroomId}.v2` } }));
    console.log(`[chat] Kick: conectado al canal #${kickSlug} (chatroom ${chatroomId})`);
  };
  kickWs.onmessage = (event) => handleKickPusherEvent(event.data);
  kickWs.onclose = () => { kickWs = null; if (!kickStopped) scheduleKickReconnect(); };
  kickWs.onerror = () => { /* onclose se dispara después — la reconexión se maneja ahí */ };
}

function scheduleKickReconnect() {
  clearTimeout(kickReconnectTimer);
  kickReconnectTimer = setTimeout(connectKick, kickReconnectDelay);
  kickReconnectDelay = Math.min(kickReconnectDelay * 2, MAX_RECONNECT_DELAY);
}

export function startKickChat(slug) {
  if (!slug) return;
  if (!kickStopped && kickSlug === slug) return; // ya conectado a ese canal
  stopKickChat();
  kickStopped = false;
  kickSlug = slug;
  connectKick();
}

export function stopKickChat() {
  kickStopped = true;
  clearTimeout(kickReconnectTimer);
  kickSlug = null;
  if (kickWs) { try { kickWs.close(); } catch {} kickWs = null; }
}
