// Desarrollado por BlacKraken Solutions (NABA-OL)
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
