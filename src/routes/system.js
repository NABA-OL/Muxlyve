// Desarrollado por "BlacKraken Solutions"
// Correo: nabaol.dev@gmail.com
// Fecha: 2026-07-25
// Fase 3 del refactor (docs/PLAN_REFACTOR_PANEL.md) — endpoints de estado/ajustes
// generales del motor: /api/state, /api/config, /api/stream-key, /api/public-ip,
// /api/audio, /api/viewers, /api/settings, /api/notify-test-*, /api/pick-folder.
//
// Contrato: handle(req, res, url, ctx) devuelve true si atendió la request, false si no
// le corresponde — panel.js recorre los módulos de src/routes/ en orden hasta que uno
// devuelva true. ctx trae { config, json, readBody, t, buildState } — ver panel.js.
import { audioBus } from '../monitor.js';
import { getViewerCounts } from '../viewers.js';
import { getOrCreatePanelToken } from '../panelAuth.js';
import {
  loadSettings, saveSettings, isValidStreamKey,
  isValidDiscordWebhook, isValidTelegramBot, MAX_DISCORD_WEBHOOKS, MAX_TELEGRAM_BOTS,
} from '../settings.js';
import { testDiscordWebhook } from '../notify.js';
import { testTelegramBot } from '../telegram.js';

let publicIpCache = null; // { ip, at } — evita golpear el servicio externo en cada carga del panel
const PUBLIC_IP_TTL_MS = 5 * 60 * 1000;

async function fetchPublicIp() {
  if (publicIpCache && Date.now() - publicIpCache.at < PUBLIC_IP_TTL_MS) return publicIpCache.ip;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    const { ip } = await r.json();
    publicIpCache = { ip, at: Date.now() };
    return ip;
  } catch {
    return publicIpCache?.ip || null; // sirve la última conocida si el servicio falla
  } finally {
    clearTimeout(timeout);
  }
}

export async function handle(req, res, url, ctx) {
  const { config, json, readBody, t, buildState } = ctx;

  if (req.method === 'GET' && url.pathname === '/api/state') {
    json(res, 200, buildState());
    return true;
  }

  // Config del ingest (URL/clave/preview) — streamKey/flvUrl se recalculan de
  // settings.json en cada pedido (no vienen del snapshot de arranque) para que un
  // cambio de clave desde el panel se vea sin reiniciar la app.
  if (req.method === 'GET' && url.pathname === '/api/config') {
    const settings = loadSettings();
    json(res, 200, {
      rtmpUrl: config.rtmpUrl || '',
      lanRtmpUrl: config.lanRtmpUrl || '',
      lanIp: config.lanIp || null,
      rtmpPort: config.rtmpPort || null,
      streamKey: settings.streamKey,
      flvUrl: config.httpPort ? `http://localhost:${config.httpPort}/live/${settings.streamKey}.flv` : '',
      version: config.version || '0.0.0',
      panelToken: process.env.ALLOW_LAN_PANEL === 'true' ? getOrCreatePanelToken() : null,
      chatCommandsEnabled: settings.chatCommandsEnabled,
      discordWebhooks: settings.discordWebhooks,
      telegramBots: settings.telegramBots,
      liveMessage: settings.liveMessage || '',
    });
    return true;
  }

  // POST /api/stream-key { streamKey } — cambia la clave de retransmisión. El valor
  // por defecto (env STREAM_KEY o "mistream") no se toca hasta que el usuario la
  // edite acá — ver settings.js.
  if (req.method === 'POST' && url.pathname === '/api/stream-key') {
    let input;
    try { input = await readBody(req); } catch (err) { json(res, 400, { error: err.message }); return true; }
    const streamKey = typeof input.streamKey === 'string' ? input.streamKey.trim() : '';
    if (!isValidStreamKey(streamKey)) {
      json(res, 400, { error: t('La clave debe tener 3-64 caracteres: letras, números, guion o guion bajo.') });
      return true;
    }
    saveSettings({ streamKey });
    json(res, 200, { ok: true, streamKey });
    return true;
  }

  // GET /api/public-ip -> IP pública (para exponer el ingest fuera de la red local vía port forwarding)
  if (req.method === 'GET' && url.pathname === '/api/public-ip') {
    const ip = await fetchPublicIp();
    json(res, 200, { ip });
    return true;
  }

  // GET /api/audio -> SSE: niveles de audio L/R en tiempo real (~16 Hz) para el VU meter.
  if (req.method === 'GET' && url.pathname === '/api/audio') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const onLevel = (lvl) => res.write(`data: ${JSON.stringify(lvl)}\n\n`);
    audioBus.on('level', onLevel);
    req.on('close', () => audioBus.off('level', onLevel));
    return true;
  }

  // GET /api/viewers -> { twitch: {count, live}, kick: {...} } — último valor sondeado
  // por electron/oauth.js. Lo consultan tanto el panel principal como el popout de chat.
  if (req.method === 'GET' && url.pathname === '/api/viewers') {
    json(res, 200, getViewerCounts());
    return true;
  }

  // POST /api/settings  { chatCommandsEnabled?, discordWebhooks?, telegramBots?,
  // liveMessage? } -> ajustes sueltos del motor que no encajan en ningún endpoint más
  // específico. YAGNI — si sigue creciendo, ahí sí vale la pena generalizar esto.
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    const patch = {};
    if ('chatCommandsEnabled' in input) patch.chatCommandsEnabled = !!input.chatCommandsEnabled;
    if ('discordWebhooks' in input) {
      const list = Array.isArray(input.discordWebhooks) ? input.discordWebhooks : [];
      if (list.length > MAX_DISCORD_WEBHOOKS) {
        json(res, 400, { error: t(`Máximo ${MAX_DISCORD_WEBHOOKS} webhooks de Discord.`) });
        return true;
      }
      const cleaned = list.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
      if (cleaned.some((u) => !isValidDiscordWebhook(u))) {
        json(res, 400, { error: t('Una de las URLs de Discord no es válida — debe ser https://discord.com/api/webhooks/...') });
        return true;
      }
      patch.discordWebhooks = cleaned;
    }
    if ('telegramBots' in input) {
      const list = Array.isArray(input.telegramBots) ? input.telegramBots : [];
      if (list.length > MAX_TELEGRAM_BOTS) {
        json(res, 400, { error: t(`Máximo ${MAX_TELEGRAM_BOTS} bots de Telegram.`) });
        return true;
      }
      const cleaned = list
        .map((b) => ({ botToken: String(b?.botToken || '').trim(), chatId: String(b?.chatId || '').trim() }))
        .filter((b) => b.botToken || b.chatId);
      if (cleaned.some((b) => !isValidTelegramBot(b))) {
        json(res, 400, { error: t('Uno de los bots de Telegram tiene el token o el chat ID inválido.') });
        return true;
      }
      patch.telegramBots = cleaned;
    }
    if ('liveMessage' in input) {
      const msg = typeof input.liveMessage === 'string' ? input.liveMessage.trim() : '';
      if (msg.length > 2000) { json(res, 400, { error: t('El mensaje no puede superar los 2000 caracteres.') }); return true; }
      patch.liveMessage = msg || null;
    }
    saveSettings(patch);
    json(res, 200, { ok: true });
    return true;
  }

  // POST /api/notify-test-discord  { url } -> prueba UN webhook puntual, sin necesidad
  // de haberlo guardado antes (así se puede probar antes de confirmar). Ignora el
  // cooldown de 30 min (ver src/notify.js) — botón "Probar" de cada fila.
  if (req.method === 'POST' && url.pathname === '/api/notify-test-discord') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    json(res, 200, await testDiscordWebhook(input.url));
    return true;
  }

  // POST /api/notify-test-telegram  { botToken, chatId } -> mismo criterio, para un bot
  // de Telegram puntual.
  if (req.method === 'POST' && url.pathname === '/api/notify-test-telegram') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    json(res, 200, await testTelegramBot(input.botToken, input.chatId));
    return true;
  }

  // POST /api/notify-test-all -> dispara el mensaje de aviso YA GUARDADO a TODOS los
  // canales configurados (Discord + Telegram) de una — botón "Probar" del modal de
  // mensaje (previsualiza cómo va a quedar en cada uno, no uno a la vez).
  if (req.method === 'POST' && url.pathname === '/api/notify-test-all') {
    const settings = loadSettings();
    const results = [];
    for (let i = 0; i < settings.discordWebhooks.length; i++) {
      results.push({ platform: 'discord', index: i + 1, ...(await testDiscordWebhook(settings.discordWebhooks[i])) });
    }
    for (let i = 0; i < settings.telegramBots.length; i++) {
      const bot = settings.telegramBots[i];
      results.push({ platform: 'telegram', index: i + 1, ...(await testTelegramBot(bot.botToken, bot.chatId)) });
    }
    json(res, 200, { results });
    return true;
  }

  // GET /api/pick-folder  → abre el selector nativo de carpetas (solo Electron)
  if (req.method === 'GET' && url.pathname === '/api/pick-folder') {
    try {
      const { dialog, BrowserWindow } = await import('electron');
      const win = BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Carpeta de clips' });
      json(res, 200, { path: result.canceled ? null : result.filePaths[0] });
    } catch {
      json(res, 501, { error: t('Selector solo disponible en la app de escritorio.') });
    }
    return true;
  }

  return false;
}
