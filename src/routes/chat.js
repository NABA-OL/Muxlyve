// Desarrollado por BlacKraken Solutions (NABA-OL)
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
} from '../chatmod.js';

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
    chatBus.on('message', onMessage);
    req.on('close', () => chatBus.off('message', onMessage));
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

  return false;
}
