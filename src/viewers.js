// Propiedad de BlacKraken Solutions
// Desarrollado por NABA-OL
// Store en memoria de espectadores por plataforma — electron/oauth.js hace el polling real
// contra Twitch/Kick (necesita los tokens OAuth, que viven ahí) y empuja acá con
// setViewerCounts(); panel.js sirve el último valor por HTTP (GET /api/viewers) para que
// tanto la ventana principal como el popout de chat lo puedan leer sin IPC (el popout no
// tiene preload — ver electron/main.js openChatWindow).
let counts = {};
// Picos de espectadores DE LA SESIÓN de transmisión actual — separado de `counts` (que es
// "ahora mismo") a propósito: para el historial (Fase 6, docs/PLAN_FEATURES_LOTE2.md)
// hace falta poder leer el pico DESPUÉS de que la sesión terminó y `counts` ya volvió a
// reflejar "sin transmisión". Se resetea en onPublish() (relays.js), se lee (sin
// resetear) en onUnpublish() al armar el registro de historial.
let peaks = {};

export function setViewerCounts(next) {
  counts = next;
  for (const [platform, info] of Object.entries(next || {})) {
    const c = info?.count;
    if (typeof c === 'number' && c > (peaks[platform] || 0)) peaks[platform] = c;
  }
}

export function getViewerCounts() {
  return counts;
}

export function getSessionPeaks() {
  return { ...peaks };
}

export function resetSessionPeaks() {
  peaks = {};
}
