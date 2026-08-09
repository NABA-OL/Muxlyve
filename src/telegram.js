// Propiedad de BlacKraken Solutions
// Desarrollado por NABA-OL
// Aviso "estoy en vivo" a hasta 3 bots de Telegram — mismo patrón que src/notify.js
// (Discord), mismo mensaje compartido (liveMessage en settings.js). A diferencia de
// Discord, acá no hay URL que el usuario pegue: el host SIEMPRE es api.telegram.org
// (fijo, no hay SSRF posible por ahí) — lo que sí es input del usuario es el bot token
// (va en el PATH de la URL) y el chatId (va en el body). isValidTelegramBot vive en
// settings.js, mismo criterio que isValidDiscordWebhook: validado al guardar Y al usar.
import { loadSettings, isValidTelegramBot } from './settings.js';

// Mismo criterio que notify.js: un cooldown compartido para los hasta 3 bots juntos, y
// separado por kind (start/end) — ver el comentario en notify.js sobre por qué.
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
const lastNotifyAt = { start: 0, end: 0 };

const DEFAULT_MESSAGES = { start: '🔴 ¡La transmisión empezó!', end: '⚫ La transmisión terminó.' };

// El mensaje se escribe pensando en Discord (**negrita**, *itálica* o _itálica_) —
// Telegram usa su propia sintaxis MarkdownV2, e INVERTIDA para negrita/itálica: un solo
// asterisco es negrita en Telegram, itálica en Discord. Mandar el texto de Discord tal
// cual con parse_mode puesto lo rompe (asteriscos de más cuentan como negrita mal
// cerrada) o Telegram lo rechaza directo por los caracteres reservados de MarkdownV2
// (14 símbolos, entre ellos ".", "!", "-") sin escapar.
const MDV2_RESERVED_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;
function escapeMarkdownV2(text) {
  return text.replace(MDV2_RESERVED_RE, '\\$&');
}

// Recorre el texto UNA sola vez con regex.exec + lastIndex, sin marcador temporal de por
// medio — un intento anterior usaba un placeholder para "reservar" los tramos ya
// traducidos y pegarlos de vuelta al final, pero eso abre la puerta a que el marcador
// choque con contenido real del mensaje (ej. un número suelto). Alternancia en orden:
// negrita (**x**) se intenta antes que itálica de un asterisco en cada posición, así "**"
// nunca se lee como dos itálicas pegadas.
const EMPHASIS_RE = /\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_/g;
export function discordToTelegramMarkdown(text) {
  let result = '';
  let lastIndex = 0;
  let match;
  EMPHASIS_RE.lastIndex = 0;
  while ((match = EMPHASIS_RE.exec(text))) {
    result += escapeMarkdownV2(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) result += '*' + escapeMarkdownV2(match[1]) + '*'; // **negrita** (Discord) -> *negrita* (Telegram)
    else if (match[2] !== undefined) result += '_' + escapeMarkdownV2(match[2]) + '_'; // *itálica* (Discord) -> _itálica_ (Telegram)
    else result += '_' + escapeMarkdownV2(match[3]) + '_'; // _itálica_ -> igual en los dos formatos
    lastIndex = EMPHASIS_RE.lastIndex;
  }
  result += escapeMarkdownV2(text.slice(lastIndex));
  return result;
}

async function postToTelegram(botToken, chatId, text) {
  // encodeURIComponent en el token: ya pasó por isValidTelegramBot (regex) antes de
  // llegar acá, pero esto es la segunda capa — nunca confiar en un solo punto de
  // validación para algo que termina armando una URL.
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
  const send = (body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  let res = await send({ chat_id: chatId, text: discordToTelegramMarkdown(text), parse_mode: 'MarkdownV2' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Si la traducción igual generó algo que Telegram no pudo parsear (caso raro —
    // énfasis sin cerrar, etc.), reintenta UNA vez en texto plano. El aviso de que
    // arrancaste en vivo no se puede perder por un problema de formato — mejor que
    // llegue sin negrita a que no llegue.
    if (body.error_code === 400 && /can't parse/i.test(body.description || '')) {
      res = await send({ chat_id: chatId, text });
      if (!res.ok) {
        const retryBody = await res.json().catch(() => ({}));
        throw new Error(retryBody.description || `Telegram respondió ${res.status}`);
      }
      return;
    }
    throw new Error(body.description || `Telegram respondió ${res.status}`);
  }
}

// Llamado desde onPublish()/onUnpublish() en relays.js según kind ('start'/'end'), igual
// que notifyDiscord() — nunca debe poder tumbar el arranque/cierre del stream, y un bot
// caído no frena a los demás (allSettled).
export async function notifyTelegram(kind = 'start') {
  const { telegramBots, liveMessage, endMessage } = loadSettings();
  const active = telegramBots.filter((b) => b.enabled);
  if (!active.length) return;
  if (Date.now() - lastNotifyAt[kind] < NOTIFY_COOLDOWN_MS) return;
  lastNotifyAt[kind] = Date.now();
  const message = (kind === 'end' ? endMessage : liveMessage) || DEFAULT_MESSAGES[kind];
  const results = await Promise.allSettled(
    active.map((bot) => postToTelegram(bot.botToken, bot.chatId, message)),
  );
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') console.log(`[notify] Telegram #${i + 1} (${kind}) — aviso enviado.`);
    else console.error(`[notify] Telegram #${i + 1} (${kind}) — no se pudo avisar —`, r.reason.message);
  });
}

// Botón "Probar" de cada fila — prueba un bot puntual sin necesidad de guardarlo antes.
// Ignora el cooldown a propósito.
export async function testTelegramBot(botToken, chatId, kind = 'start') {
  const clean = { botToken: String(botToken || '').trim(), chatId: String(chatId || '').trim() };
  if (!isValidTelegramBot(clean)) {
    return { ok: false, error: 'Bot token o chat ID inválido.' };
  }
  const { liveMessage, endMessage } = loadSettings();
  const message = (kind === 'end' ? endMessage : liveMessage) || DEFAULT_MESSAGES[kind];
  try {
    await postToTelegram(clean.botToken, clean.chatId, `[Prueba de Muxlyve]\n${message}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
