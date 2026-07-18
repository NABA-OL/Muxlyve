// Desarrollado por BlacKraken Solutions (NABA-OL)
// Store en memoria de espectadores por plataforma — electron/oauth.js hace el polling real
// contra Twitch/Kick (necesita los tokens OAuth, que viven ahí) y empuja acá con
// setViewerCounts(); panel.js sirve el último valor por HTTP (GET /api/viewers) para que
// tanto la ventana principal como el popout de chat lo puedan leer sin IPC (el popout no
// tiene preload — ver electron/main.js openChatWindow).
let counts = {};

export function setViewerCounts(next) {
  counts = next;
}

export function getViewerCounts() {
  return counts;
}
