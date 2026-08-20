/*
 * Propiedad de BlacKraken Solutions
 * Desarrollado por: NABAOL
 * Fecha de creación: 2026-07-01
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
// Puente para aplicar modo lento/solo-emotes desde CUALQUIER ventana (panel principal o
// popout de chat) por HTTP en vez de IPC — el popout no tiene preload/contextBridge (ver
// electron/main.js openChatWindow), así que IPC no le sirve. electron/oauth.js registra
// el handler real (necesita los tokens OAuth); panel.js expone POST /api/chat-mode y lo
// invoca — mismo mecanismo que src/viewers.js usa para los espectadores.
let handler = null;

export function setChatModeHandler(fn) {
  handler = fn;
}

export async function applyChatMode(opts) {
  if (!handler) return { ok: false, error: 'No disponible — requiere la app de escritorio.' };
  return handler(opts);
}

// Mismo puente, para enviar un mensaje como el streamer a todas las plataformas conectadas
// que lo soporten (Twitch + Kick — ver electron/oauth.js sendChatMessage).
let sendHandler = null;

export function setChatSendHandler(fn) {
  sendHandler = fn;
}

export async function sendChatMessage(text) {
  if (!sendHandler) return { ok: false, error: 'No disponible — requiere la app de escritorio.' };
  return sendHandler(text);
}

// Mismo puente, para fijar un mensaje — solo Twitch soporta esto por API pública real (ver
// electron/oauth.js pinTwitchMessage). Kick lo tiene solo en su dashboard interno, YouTube
// no lo tiene en absoluto.
let pinHandler = null;

export function setChatPinHandler(fn) {
  pinHandler = fn;
}

export async function pinChatMessage(messageId) {
  if (!pinHandler) return { ok: false, error: 'No disponible — requiere la app de escritorio.' };
  return pinHandler(messageId);
}

// Desfijar — mismo criterio, ver electron/oauth.js unpinTwitchMessage.
let unpinHandler = null;

export function setChatUnpinHandler(fn) {
  unpinHandler = fn;
}

export async function unpinChatMessage(messageId) {
  if (!unpinHandler) return { ok: false, error: 'No disponible — requiere la app de escritorio.' };
  return unpinHandler(messageId);
}

// Consultar qué mensaje está fijado ahora mismo — para que el botón de la UI arranque
// sincronizado con el estado real de Twitch (ej. tras reiniciar la app, o si se fijó/
// desfijó algo desde el dashboard de Twitch en vez de desde acá).
let getPinnedHandler = null;

export function setChatGetPinnedHandler(fn) {
  getPinnedHandler = fn;
}

export async function getChatPinned() {
  if (!getPinnedHandler) return { ok: false, error: 'No disponible — requiere la app de escritorio.' };
  return getPinnedHandler();
}

// Mismo puente, para timeout/ban — Twitch y YouTube (ver electron/oauth.js
// banChatUserDispatch). duration en segundos: presente = timeout, ausente/null = ban
// permanente — mismo criterio que la API de Twitch (moderation/bans) y YouTube
// (liveChatBans, type temporary/permanent), no se reinterpreta acá. platform decide a
// cuál de las dos pega el dispatcher — el id de usuario de una no sirve en la otra.
let banHandler = null;

export function setChatBanHandler(fn) {
  banHandler = fn;
}

export async function banChatUser(userId, duration, reason, platform) {
  if (!banHandler) return { ok: false, error: 'No disponible — requiere la app de escritorio.' };
  return banHandler(userId, duration, reason, platform);
}
