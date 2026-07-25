// Desarrollado por BlacKraken Solutions (NABA-OL)
// Aviso "estoy en vivo" a hasta 3 webhooks de Discord — opt-in, ver discordWebhooks en
// src/settings.js. isValidDiscordWebhook vive en settings.js (no acá) para que la use
// tanto el guardado desde el panel como el envío real, sin import circular (este módulo
// ya depende de settings.js para loadSettings()).
//
// La validación de host/protocolo NO es opcional: cada URL es algo que el usuario pega y
// que este proceso llama por su cuenta — sin filtrar a https+discord.com es un SSRF con
// destino elegible por quien tenga acceso al panel. Mismo criterio que openExternalSafe()
// en electron/main.js.
import { loadSettings, isValidDiscordWebhook } from './settings.js';

// Evita un segundo aviso si OBS se reconecta (onPublish se vuelve a llamar) — no es un
// segundo "empezaste a transmitir" real. Un solo cooldown para los 3 webhooks juntos: si
// se reconecta, no se re-manda a NINGUNO, no solo al primero.
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
let lastNotifyAt = 0;

const DEFAULT_MESSAGE = '🔴 ¡La transmisión empezó!';

async function postToDiscord(webhookUrl, content) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Discord respondió ${res.status}`);
}

// Llamado desde onPublish() en relays.js. Nunca debe poder tumbar el arranque del
// stream — cualquier falla en UNO de los webhooks (Discord caído, URL mala, timeout)
// queda en el log y no afecta a los otros (Promise.allSettled, no Promise.all). El
// mensaje es el que el streamer haya escrito en el modal "Mensaje de aviso" del panel
// (liveMessage, compartido con Telegram) — si nunca lo tocó, cae al texto genérico de
// siempre. Discord interpreta markdown en `content` tal cual (negrita, itálica, links) —
// no hace falta procesarlo acá, se manda literal.
export async function notifyDiscord() {
  const { discordWebhooks, liveMessage } = loadSettings();
  if (!discordWebhooks.length) return;
  if (Date.now() - lastNotifyAt < NOTIFY_COOLDOWN_MS) return;
  lastNotifyAt = Date.now();
  const message = liveMessage || DEFAULT_MESSAGE;
  const results = await Promise.allSettled(discordWebhooks.map((url) => postToDiscord(url, message)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') console.log(`[notify] Discord #${i + 1} — aviso enviado.`);
    else console.error(`[notify] Discord #${i + 1} — no se pudo avisar —`, r.reason.message);
  });
}

// Botón "Probar" de cada fila en Preferencias → Webhooks — prueba UNA url puntual (no
// necesita estar guardada todavía, así el streamer puede probar antes de guardar). Manda
// el mensaje REAL configurado con un prefijo que deja claro que es una prueba. Ignora el
// cooldown a propósito — el usuario lo pidió ahora mismo, no es un rebote de reconexión.
export async function testDiscordWebhook(url) {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!isValidDiscordWebhook(trimmed)) {
    return { ok: false, error: 'URL de webhook inválida — debe ser https://discord.com/api/webhooks/...' };
  }
  const { liveMessage } = loadSettings();
  try {
    await postToDiscord(trimmed, `**[Prueba de Muxlyve]**\n${liveMessage || DEFAULT_MESSAGE}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
