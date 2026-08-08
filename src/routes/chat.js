// Desarrollado por "BlacKraken Solutions"
// Correo: nabaol.dev@gmail.com
// Fecha: 2026-07-25
// Fase 3 del refactor (docs/PLAN_REFACTOR_PANEL.md) — endpoints de chat unificado:
// /api/chat (SSE), /api/chat-mode, /api/chat-send, /api/chat-pin, /api/chat-unpin,
// /api/chat-pinned. Ver contrato en src/routes/system.js.
import { chatBus, getHistory as getChatHistory } from '../chat.js';
import {
  applyChatMode as applyChatModeBackend,
  sendChatMessage as sendChatMessageBackend,
  pinChatMessage as pinChatMessageBackend,
  unpinChatMessage as unpinChatMessageBackend,
  getChatPinned as getChatPinnedBackend,
  banChatUser as banChatUserBackend,
} from '../chatmod.js';

// Tope real que exige Twitch para /helix/moderation/bans (14 días, en segundos) —
// validado acá para devolver un error claro en español en vez de que Twitch lo rechace
// con un 400 críptico.
const MAX_BAN_DURATION_SECONDS = 1209600;

export async function handle(req, res, url, ctx) {
  const { json, readBody, t } = ctx;

  // GET /api/chat -> SSE: mensajes de chat unificados (Twitch/Kick). Ruta pública en LAN
  // (ver PUBLIC_LAN_PATHS en panel.js) — el overlay de OBS la consume sin token.
  if (req.method === 'GET' && url.pathname === '/api/chat') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const msg of getChatHistory()) res.write(`data: ${JSON.stringify(msg)}\n\n`);
    const onMessage = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
    // Llega aparte y un ratito después del mensaje original (ver maybeTranslate() en
    // src/chat.js) — el cliente la reconoce por type:'translation' (los mensajes
    // normales nunca traen ese campo) y solo anota la fila que ya pintó, no repinta nada.
    const onTranslated = (payload) => res.write(`data: ${JSON.stringify({ type: 'translation', ...payload })}\n\n`);
    chatBus.on('message', onMessage);
    chatBus.on('message-translated', onTranslated);
    req.on('close', () => {
      chatBus.off('message', onMessage);
      chatBus.off('message-translated', onTranslated);
    });
    return true;
  }

  // POST /api/chat-mode -> modo lento / solo emotes (solo Twitch, ver src/chatmod.js).
  // Por HTTP y no IPC para que el popout de chat también lo pueda usar (no tiene preload).
  if (req.method === 'POST' && url.pathname === '/api/chat-mode') {
    const body = await readBody(req);
    json(res, 200, await applyChatModeBackend({
      emoteOnly: !!body.emoteOnly,
      subscriberOnly: !!body.subscriberOnly,
      slowSeconds: Number(body.slowSeconds) || 0,
    }));
    return true;
  }

  // POST /api/chat-send -> publica un mensaje como el streamer en Twitch + Kick (chatmod.js).
  if (req.method === 'POST' && url.pathname === '/api/chat-send') {
    const body = await readBody(req);
    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) { json(res, 400, { error: t('Mensaje vacío.') }); return true; }
    json(res, 200, await sendChatMessageBackend(text));
    return true;
  }

  // POST /api/chat-pin -> fija un mensaje (solo Twitch, ver src/chatmod.js).
  if (req.method === 'POST' && url.pathname === '/api/chat-pin') {
    const body = await readBody(req);
    const messageId = String(body.messageId || '').trim();
    if (!messageId) { json(res, 400, { error: t('Falta el id del mensaje.') }); return true; }
    json(res, 200, await pinChatMessageBackend(messageId));
    return true;
  }

  // POST /api/chat-unpin -> desfija (solo Twitch, ver src/chatmod.js).
  if (req.method === 'POST' && url.pathname === '/api/chat-unpin') {
    const body = await readBody(req);
    const messageId = String(body.messageId || '').trim();
    if (!messageId) { json(res, 400, { error: t('Falta el id del mensaje.') }); return true; }
    json(res, 200, await unpinChatMessageBackend(messageId));
    return true;
  }

  // GET /api/chat-pinned -> id del mensaje fijado ahora mismo en Twitch (o null si no hay
  // ninguno) — para que el botón arranque sincronizado con el estado real, no a ciegas.
  if (req.method === 'GET' && url.pathname === '/api/chat-pinned') {
    json(res, 200, await getChatPinnedBackend());
    return true;
  }

  // POST /api/chat-ban  { userId, duration?, reason? } -> timeout (con duration, en
  // segundos) o ban permanente (sin duration) — solo Twitch, ver src/chatmod.js /
  // electron/oauth.js banTwitchUser. Fase 5 del lote 2 (docs/PLAN_FEATURES_LOTE2.md).
  if (req.method === 'POST' && url.pathname === '/api/chat-ban') {
    const body = await readBody(req);
    const userId = String(body.userId || '').trim();
    if (!userId) { json(res, 400, { error: t('Falta el id del usuario.') }); return true; }
    let duration;
    if (body.duration !== undefined && body.duration !== null) {
      duration = Number(body.duration);
      if (!Number.isInteger(duration) || duration <= 0 || duration > MAX_BAN_DURATION_SECONDS) {
        json(res, 400, { error: t('Duración de timeout inválida.') });
        return true;
      }
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined;
    json(res, 200, await banChatUserBackend(userId, duration, reason));
    return true;
  }

  return false;
}
