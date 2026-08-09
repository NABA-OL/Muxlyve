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
import { loadAll, saveAll } from '../destinations.js';
import { applyChange } from '../relays.js';
import { validateDestination } from './destinations.js';

// Fase 1 del lote 2 (docs/PLAN_FEATURES_LOTE2.md) — exportar/importar configuración.
// Whitelist explícita: cualquier otra clave del archivo importado se ignora en silencio,
// nunca se escribe tal cual a disco. Los valores DENTRO de cada campo aceptado igual
// pasan por el saneado normal de loadSettings() (ver el comentario en el endpoint de
// abajo) — esto solo decide QUÉ campos se consideran, no valida su contenido.
const IMPORTABLE_SETTINGS_FIELDS = [
  'streamKey', 'recArmed', 'fullRecArmed', 'recDuration', 'clipsDir', 'recordingsDir',
  'chatCommandsEnabled', 'discordWebhooks', 'telegramBots', 'liveMessage', 'endMessage',
  'destinationPresets', 'audioSilenceAlertEnabled', 'chatTranslateEnabled',
];

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
      endMessage: settings.endMessage || '',
      audioSilenceAlertEnabled: settings.audioSilenceAlertEnabled,
      chatTranslateEnabled: settings.chatTranslateEnabled,
    });
    return true;
  }

  // GET /api/config/export -> destinations.json + settings.json juntos, para
  // backup/migración de máquina (Fase 1 del lote 2, docs/PLAN_FEATURES_LOTE2.md). Va en
  // texto plano a propósito — loadAll() ya devuelve las URLs DESENCRIPTADAS aunque haya
  // MASTER_KEY (las claves de retransmisión viajan en la URL misma), así que el archivo
  // resultante es tan sensible como el destinations.json/settings.json de origen. El
  // aviso de "guárdalo con cuidado" vive del lado del cliente (botón de exportar), acá
  // solo se arma el JSON — este endpoint no decide UI.
  if (req.method === 'GET' && url.pathname === '/api/config/export') {
    json(res, 200, {
      exportedAt: Date.now(),
      destinations: loadAll(),
      settings: loadSettings(),
    });
    return true;
  }

  // POST /api/config/import  { destinations: [...], settings: {...} } -> reemplaza
  // destinos + ajustes del motor con los del archivo. Nada de importar parcial en
  // silencio: si UN destino es inválido, se rechaza el archivo completo antes de tocar
  // nada (mismo validateDestination que ya usa POST /api/destinations, ver
  // src/routes/destinations.js).
  //
  // Nota sobre el chequeo de "¿es tu propia cuenta?": ESTE endpoint no sabe nada de
  // licencias — Freemius/license.js vive en electron/, y src/ tiene que poder correr
  // headless/Docker sin Electron. Por eso esa comparación (correo de la licencia que
  // exportó vs. la de esta máquina) la hace el CLIENTE antes de mandar el POST acá (ver
  // importConfig() en panel-client.js) — acá solo llega la data ya confirmada por el
  // usuario, sea cual sea el resultado de esa comparación.
  if (req.method === 'POST' && url.pathname === '/api/config/import') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    if (!Array.isArray(input.destinations) || !input.settings || typeof input.settings !== 'object') {
      json(res, 400, { error: t('Archivo de configuración inválido — falta destinations o settings.') });
      return true;
    }
    const validated = [];
    for (const raw of input.destinations) {
      const { error, dest } = validateDestination(raw || {}, t);
      if (error) {
        json(res, 400, { error: t('Destino inválido en el archivo ("') + (raw?.name || '?') + t('"): ') + error });
        return true;
      }
      validated.push(dest);
    }
    const settingsPatch = {};
    for (const field of IMPORTABLE_SETTINGS_FIELDS) {
      if (field in input.settings) settingsPatch[field] = input.settings[field];
    }
    saveSettings(settingsPatch);
    // loadSettings() ya sanea cada campo al leer (isValidStreamKey, validDiscordWebhooks,
    // validTelegramBots, etc. — ver settings.js) — volver a guardar lo recién leído
    // reescribe la versión LIMPIA sobre el archivo, sin tener que duplicar acá ninguna de
    // esas validaciones. El archivo importado es "no confiable" por definición (puede
    // venir de cualquier lado), este paso lo trata igual que cualquier settings.json
    // editado a mano.
    saveSettings(loadSettings());
    // Aplica los destinos como si fuera un guardado manual uno por uno — applyChange no
    // interrumpe un relay activo si ese destino puntual no cambió de estado.
    saveAll(validated);
    validated.forEach(applyChange);
    json(res, 200, buildState());
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

  // GET /api/audio -> SSE: niveles de audio L/R en tiempo real (~16 Hz) para el VU meter,
  // más avisos puntuales de "silencio sostenido" (ver checkSilenceWatchdog en
  // src/monitor.js) — mismo stream, discriminado por `type` para no abrir una segunda
  // conexión SSE solo para esto.
  if (req.method === 'GET' && url.pathname === '/api/audio') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const onLevel = (lvl) => res.write(`data: ${JSON.stringify({ type: 'level', ...lvl })}\n\n`);
    const onSilence = (info) => res.write(`data: ${JSON.stringify({ type: 'silence', ...info })}\n\n`);
    audioBus.on('level', onLevel);
    audioBus.on('silence', onSilence);
    req.on('close', () => {
      audioBus.off('level', onLevel);
      audioBus.off('silence', onSilence);
    });
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
    if ('audioSilenceAlertEnabled' in input) patch.audioSilenceAlertEnabled = !!input.audioSilenceAlertEnabled;
    if ('chatTranslateEnabled' in input) patch.chatTranslateEnabled = !!input.chatTranslateEnabled;
    if ('discordWebhooks' in input) {
      const list = Array.isArray(input.discordWebhooks) ? input.discordWebhooks : [];
      if (list.length > MAX_DISCORD_WEBHOOKS) {
        json(res, 400, { error: t(`Máximo ${MAX_DISCORD_WEBHOOKS} webhooks de Discord.`) });
        return true;
      }
      // Acepta {url, enabled} (forma actual) o un string plano (compat con lo que
      // mande un cliente viejo) — enabled default true si no viene o no es booleano.
      const cleaned = list
        .map((w) => ({
          url: typeof w === 'string' ? w.trim() : (typeof w?.url === 'string' ? w.url.trim() : ''),
          enabled: typeof w === 'object' && w !== null && typeof w.enabled === 'boolean' ? w.enabled : true,
        }))
        .filter((w) => w.url);
      if (cleaned.some((w) => !isValidDiscordWebhook(w.url))) {
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
        .map((b) => ({
          botToken: String(b?.botToken || '').trim(),
          chatId: String(b?.chatId || '').trim(),
          enabled: typeof b?.enabled === 'boolean' ? b.enabled : true,
        }))
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
    if ('endMessage' in input) {
      const msg = typeof input.endMessage === 'string' ? input.endMessage.trim() : '';
      if (msg.length > 2000) { json(res, 400, { error: t('El mensaje no puede superar los 2000 caracteres.') }); return true; }
      patch.endMessage = msg || null;
    }
    // writeFileSync puede fallar (EBUSY/EPERM) si algo más tiene el archivo abierto un
    // instante — antivirus, OneDrive, etc., más común en Windows. Sin este try/catch caía
    // en el catch-all genérico de panel.js ("Error interno del panel"), sin decir qué pasó
    // de verdad — imposible de diagnosticar a distancia.
    try {
      saveSettings(patch);
    } catch (e) {
      json(res, 500, { error: t('No se pudo guardar la configuración: ') + e.message });
      return true;
    }
    json(res, 200, { ok: true });
    return true;
  }

  // POST /api/notify-test-discord  { url, kind? } -> prueba UN webhook puntual, sin
  // necesidad de haberlo guardado antes (así se puede probar antes de confirmar). Ignora
  // el cooldown de 30 min (ver src/notify.js) — botón "Probar" de cada fila. kind:
  // 'start'|'end', default 'start' (compat con clientes viejos que no lo mandan).
  if (req.method === 'POST' && url.pathname === '/api/notify-test-discord') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    json(res, 200, await testDiscordWebhook(input.url, input.kind === 'end' ? 'end' : 'start'));
    return true;
  }

  // POST /api/notify-test-telegram  { botToken, chatId, kind? } -> mismo criterio, para
  // un bot de Telegram puntual.
  if (req.method === 'POST' && url.pathname === '/api/notify-test-telegram') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    json(res, 200, await testTelegramBot(input.botToken, input.chatId, input.kind === 'end' ? 'end' : 'start'));
    return true;
  }

  // POST /api/notify-test-all  { kind? } -> dispara el mensaje YA GUARDADO (de inicio o de
  // fin, según kind) a TODOS los canales HABILITADOS (Discord + Telegram) de una — botón
  // "Probar" del modal de mensaje (previsualiza cómo va a quedar en cada uno). Los
  // deshabilitados se saltan a propósito: probar algo que no se va a mandar en vivo sería
  // engañoso, no una prueba real de lo que le va a llegar al streamer.
  if (req.method === 'POST' && url.pathname === '/api/notify-test-all') {
    let input;
    try { input = await readBody(req); } catch { input = {}; }
    const kind = input.kind === 'end' ? 'end' : 'start';
    const settings = loadSettings();
    const activeDiscord = settings.discordWebhooks.filter((w) => w.enabled);
    const activeTelegram = settings.telegramBots.filter((b) => b.enabled);
    const results = [];
    for (let i = 0; i < activeDiscord.length; i++) {
      results.push({ platform: 'discord', index: i + 1, ...(await testDiscordWebhook(activeDiscord[i].url, kind)) });
    }
    for (let i = 0; i < activeTelegram.length; i++) {
      const bot = activeTelegram[i];
      results.push({ platform: 'telegram', index: i + 1, ...(await testTelegramBot(bot.botToken, bot.chatId, kind)) });
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
