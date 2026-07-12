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
