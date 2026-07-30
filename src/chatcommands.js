// Propiedad de BlacKraken Solutions
// Desarrollado por NABA-OL
// Comandos de chat — hoy solo !clip: mods (o el broadcaster) escriben !clip en cualquier
// chat conectado y se guarda un clip del buffer rodante, sin salir del juego. Reusa
// exactamente el mismo saveClip() que el botón "Guardar clip" del panel — ver
// POST /api/record/save en src/panel.js.
import { chatBus } from './chat.js';
import { saveClip, isLive } from './relays.js';
import { loadSettings } from './settings.js';

// Evita que tres mods escribiendo !clip a la vez disparen tres FFmpeg simultáneos sobre
// el mismo buffer.
const CLIP_COOLDOWN_MS = 15 * 1000;
let lastClipAt = 0;

// Función pura — la decisión de "¿este mensaje dispara un clip?" sin tocar FFmpeg, para
// poder testearla sin tener que simular un buffer real. isLive() se chequea aparte en
// initChatCommands() porque depende de estado de relays.js, no es parte de esta decisión.
export function shouldTriggerClip(msg, nowMs, lastClipMs) {
  if (!msg || typeof msg.message !== 'string') return false;
  const firstWord = msg.message.trim().split(/\s+/)[0]?.toLowerCase();
  if (firstWord !== '!clip') return false;
  if (!msg.isMod && !msg.isBroadcaster) return false;
  if (nowMs - lastClipMs < CLIP_COOLDOWN_MS) return false;
  return true;
}

export function initChatCommands() {
  chatBus.on('message', async (msg) => {
    const settings = loadSettings();
    if (!settings.chatCommandsEnabled) return;
    const now = Date.now();
    if (!shouldTriggerClip(msg, now, lastClipAt)) return;
    if (!isLive()) return; // sin señal no hay buffer que guardar — y no gasta el cooldown
    lastClipAt = now;
    // ponytail: sin toast en la UI todavía — no hay un bus limpio para eventos "server
    // -> toast" fuera del chat mismo. El log alcanza por ahora (alimenta "Reportar un
    // problema", ver electron/logbuffer.js); agregar el toast es tarea aparte si hace falta.
    try {
      const filePath = await saveClip(settings.recDuration, settings.clipsDir);
      console.log(`[chatcmd] !clip de ${msg.username} (${msg.platform}) -> ${filePath}`);
    } catch (err) {
      console.error(`[chatcmd] !clip de ${msg.username} (${msg.platform}) FALLÓ — ${err.message}`);
    }
  });
}
