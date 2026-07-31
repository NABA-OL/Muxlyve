// Propiedad de BlacKraken Solutions
// Desarrollado por NABA-OL
// Ajustes editables desde el panel que no son "destinos" (config/destinations.json) —
// hoy solo la clave de retransmisión. Mismo criterio que destinations.js: JSON en
// MS_CONFIG_DIR (o config/ del paquete), funciona igual en Electron y headless/Docker.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.MS_CONFIG_DIR || path.join(__dirname, '..', 'config');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');

const DEFAULT_STREAM_KEY = process.env.STREAM_KEY || 'mistream';
// Segmento de URL RTMP y del path del flv — mismo criterio que las claves de destino,
// sin espacios ni caracteres que puedan romper la ruta.
const STREAM_KEY_RE = /^[A-Za-z0-9_-]{3,64}$/;

export function isValidStreamKey(key) {
  return typeof key === 'string' && STREAM_KEY_RE.test(key);
}

// Duraciones válidas del buffer rodante (segundos) — mismo set que REC_DURATIONS en
// panel.js. Se persiste acá (no solo en localStorage del panel) porque antes de este
// fix, armar el buffer SIN señal activa (armRecording) nunca guardaba la duración
// elegida — onPublish() arrancaba con el default viejo en memoria (60s = 1 min) en vez
// de la que el usuario había elegido, hasta que tocaba des/activar de nuevo YA en vivo.
const REC_DURATIONS = [60, 300, 600, 900];
export function isValidRecDuration(d) {
  return REC_DURATIONS.includes(Number(d));
}

const DEFAULT_SETTINGS = {
  streamKey: DEFAULT_STREAM_KEY, recArmed: false, fullRecArmed: false, recDuration: 60,
  clipsDir: null, recordingsDir: null, chatCommandsEnabled: true, discordWebhooks: [],
  telegramBots: [], liveMessage: null, endMessage: null, destinationPresets: [],
  audioSilenceAlertEnabled: true,
};

function validDir(d) {
  return typeof d === 'string' && d.trim() ? d.trim() : null;
}

// Límite real de Discord para el campo `content` de un webhook (Telegram permite más,
// 4096 — se usa el menor de los dos para no tener que truncar distinto por plataforma al
// mandar el mismo mensaje a ambas). Se recorta acá (al guardar) para no descubrirlo recién
// al streamear. Misma función para liveMessage (al iniciar) y endMessage (al finalizar) —
// misma validación exacta, solo cambia qué campo del settings.json la usa.
const MAX_LIVE_MSG = 2000;
function validMessage(m) {
  return typeof m === 'string' && m.trim() ? m.trim().slice(0, MAX_LIVE_MSG) : null;
}

// Validación estricta del webhook — https y host de Discord nada más. Vive acá (no en
// notify.js, que la importa) para que la reutilicen tanto el guardado desde el panel
// como el envío real, mismo criterio que isValidStreamKey de arriba. Se aplica al
// GUARDAR (endpoint) y al USAR (notify.js), no al leer — ver validDiscordWebhooks abajo.
export function isValidDiscordWebhook(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' && (u.hostname === 'discord.com' || u.hostname === 'discordapp.com');
  } catch {
    return false;
  }
}

// Hasta 3 de cada uno — un streamer con varios canales/servidores, no una lista sin
// límite. Mismo tope para Discord y Telegram, por simetría, no hay motivo real para que
// difieran.
export const MAX_DISCORD_WEBHOOKS = 3;
export const MAX_TELEGRAM_BOTS = 3;

// Filtra + dedupea + recorta al tope. Entradas inválidas se descartan en silencio acá
// (mismo criterio que validPresets) — la validación que SÍ rechaza con error al usuario
// vive en el endpoint POST /api/settings, esta es la red de seguridad al leer del disco.
function validDiscordWebhooks(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (!isValidDiscordWebhook(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_DISCORD_WEBHOOKS) break;
  }
  return out;
}

// Token de bot de Telegram: "<bot_id numérico>:<35 chars alfanuméricos/guiones>" — forma
// real de los tokens que da @BotFather. chatId puede ser un ID numérico (negativo para
// grupos/canales) o "@usuario_del_canal" — no se valida el formato exacto, Telegram lo
// rechaza solo si está mal, no vale la pena duplicar esa validación acá.
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
export function isValidTelegramBot(bot) {
  if (!bot || typeof bot !== 'object') return false;
  const token = typeof bot.botToken === 'string' ? bot.botToken.trim() : '';
  const chatId = typeof bot.chatId === 'string' ? bot.chatId.trim() : '';
  return TELEGRAM_TOKEN_RE.test(token) && chatId.length > 0;
}

function validTelegramBots(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const bot = {
      botToken: typeof raw.botToken === 'string' ? raw.botToken.trim() : '',
      chatId: typeof raw.chatId === 'string' ? raw.chatId.trim() : '',
    };
    if (!isValidTelegramBot(bot)) continue;
    out.push(bot);
    if (out.length >= MAX_TELEGRAM_BOTS) break;
  }
  return out;
}

const MAX_PRESETS = 6;

// Perfiles de destinos guardados por NOMBRE de destino (no índice — los destinos se
// pueden borrar y reordenar). Cualquier entrada mal formada se descarta sin avisar: el
// archivo lo puede haber editado el usuario a mano, nunca se confía en su forma.
// title/category son opcionales (perfiles guardados antes de esto no los tienen) — se
// normalizan a null si faltan o vienen mal, nunca undefined (para que el JSON los siga
// mostrando explícitos en vez de omitirlos).
function validPresets(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.name === 'string' && p.name.trim() && Array.isArray(p.enabled))
    .map((p) => ({
      name: p.name.trim(),
      enabled: p.enabled.filter((n) => typeof n === 'string'),
      title: typeof p.title === 'string' && p.title.trim() ? p.title.trim() : null,
      category: typeof p.category === 'string' && p.category.trim() ? p.category.trim() : null,
    }))
    .slice(0, MAX_PRESETS);
}

// Si el usuario nunca la cambió, sigue siendo la de siempre (env var o "mistream") —
// no hace falta escribir el archivo hasta que de verdad la edite. recArmed/fullRecArmed:
// "quiero que el buffer/la grabación arranque solo apenas llegue señal" — server-side
// (no localStorage) a propósito, para que el plugin de Stream Deck y el panel vean
// exactamente el mismo estado sin importar quién lo prendió. clipsDir/recordingsDir:
// mismo criterio — antes solo vivían en localStorage del panel, así que el plugin de
// Stream Deck (sin acceso a ese localStorage) siempre guardaba en la carpeta default,
// nunca en la que el usuario configuró.
export function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    return {
      streamKey: isValidStreamKey(data.streamKey) ? data.streamKey : DEFAULT_STREAM_KEY,
      recArmed: !!data.recArmed,
      fullRecArmed: !!data.fullRecArmed,
      recDuration: isValidRecDuration(data.recDuration) ? Number(data.recDuration) : 60,
      clipsDir: validDir(data.clipsDir),
      recordingsDir: validDir(data.recordingsDir),
      chatCommandsEnabled: data.chatCommandsEnabled === undefined ? true : !!data.chatCommandsEnabled,
      // Migración: discordWebhookUrl (versión anterior, un solo webhook) se suma a la
      // lista si existe — así nadie pierde el que ya tenía configurado al pasar a la
      // versión multi-webhook. discordMessage (nombre viejo) -> liveMessage (ahora
      // compartido con Telegram, ya no es "solo de Discord").
      discordWebhooks: validDiscordWebhooks([
        ...(Array.isArray(data.discordWebhooks) ? data.discordWebhooks : []),
        ...(typeof data.discordWebhookUrl === 'string' && data.discordWebhookUrl ? [data.discordWebhookUrl] : []),
      ]),
      telegramBots: validTelegramBots(data.telegramBots),
      liveMessage: validMessage(data.liveMessage ?? data.discordMessage),
      endMessage: validMessage(data.endMessage),
      destinationPresets: validPresets(data.destinationPresets),
      audioSilenceAlertEnabled: data.audioSilenceAlertEnabled === undefined ? true : !!data.audioSilenceAlertEnabled,
    };
  } catch (err) {
    console.error('[config] No se pudo leer settings.json:', err.message);
    return { ...DEFAULT_SETTINGS };
  }
}

// Merge parcial — cada llamador solo manda el campo que le importa (ej. { recArmed: true }),
// sin esto pisaría el resto del archivo (streamKey, el otro armed) con undefined.
export function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}
