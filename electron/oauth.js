// Desarrollado por BlacKraken Solutions (NABA-OL)
import { BrowserWindow, safeStorage, app, session, net } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { startTwitchChat, stopTwitchChat, startYoutubeChat, stopYoutubeChat, startKickChat, stopKickChat, setKickFetchImpl } from '../src/chat.js';
import { setViewerCounts } from '../src/viewers.js';
import { setChatModeHandler, setChatSendHandler, setChatPinHandler } from '../src/chatmod.js';

// El lookup de chatroom de Kick (ver src/chat.js) necesita el stack de red de Chromium
// para no chocar con el bloqueo de Cloudflare — net.fetch corre por ahí, el fetch global
// de Node no.
setKickFetchImpl(net.fetch);

const PLATFORMS = {
  twitch: {
    name: 'Twitch',
    authUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    // channel:manage:broadcast → título global (setStreamTitle).
    // moderator:manage:chat_settings → modo lento / solo emotes (setTwitchChatMode).
    // user:write:chat → enviar mensaje como el streamer (sendChatMessage).
    // moderator:manage:chat_messages → fijar mensaje (pinTwitchMessage).
    // Cambiar el scope invalida los tokens ya emitidos — quien ya conectó Twitch antes de
    // esto necesita reconectar.
    scope: 'user:read:email channel:read:subscriptions channel:read:stream_key channel:manage:broadcast moderator:manage:chat_settings user:write:chat moderator:manage:chat_messages',
    pkce: true,
    envKey: 'TWITCH',
    // Twitch solo acepta https:// o http://localhost — usa localhost interceptado por Electron
    useLocalhost: true,
  },
  youtube: {
    name: 'YouTube',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    pkce: false,
    envKey: 'GOOGLE',
    // Google NO acepta esquemas personalizados (muxlyve://) para clientes tipo "Aplicación
    // de escritorio" — a diferencia de RFC 8252, exige loopback (http://localhost:PUERTO).
    // Confirmado por error real de Google: "Error 400: invalid_request,
    // redirect_uri=muxlyve://oauth/youtube".
    useLocalhost: true,
  },
  kick: {
    name: 'Kick',
    authUrl: 'https://id.kick.com/oauth/authorize',
    tokenUrl: 'https://id.kick.com/oauth/token',
    // user:read → perfil. channel:read → slug del canal (necesario para el chat, que va
    // aparte por Pusher sin usar este token en absoluto — ver src/chat.js).
    // channel:write → título global (setStreamTitle).
    // chat:write → enviar mensaje como el streamer (sendChatMessage).
    // Cambiar el scope invalida los tokens ya emitidos — quien ya conectó Kick antes de
    // esto necesita reconectar.
    scope: 'user:read channel:read channel:write chat:write',
    pkce: true,
    // Cliente confidencial pese a usar PKCE — igual que Twitch, exige client_secret.
    envKey: 'KICK',
    useLocalhost: true,
  },
};

function tokensPath() {
  return path.join(app.getPath('userData'), 'oauth-tokens.json');
}

function readTokens() {
  try {
    const p = tokensPath();
    if (!existsSync(p)) return {};
    const raw = readFileSync(p);
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function writeTokens(tokens) {
  const p = tokensPath();
  mkdirSync(path.dirname(p), { recursive: true });
  const json = JSON.stringify(tokens);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json);
  writeFileSync(p, data);
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makePkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function exchangeCode(platform, code, redirectUri, verifier) {
  const cfg = PLATFORMS[platform];

  const params = new URLSearchParams({
    client_id: clientId(cfg),
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  if (cfg.pkce) params.set('code_verifier', verifier);
  // Twitch: si la app está registrada como "Confidential" (tiene Client Secret generado),
  // exige client_secret en el intercambio incluso usando PKCE — enviarlo cuando exista
  // cubre ambos tipos de cliente (Public/Confidential) sin romper ninguno.
  const secret = clientSecret(cfg);
  if (secret) params.set('client_secret', secret);

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[oauth] ${cfg.name}: error en token endpoint (status ${res.status}): ${text}`);
    throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Para Twitch trae también la stream key (scope channel:read:stream_key) y arma la URL
// RTMP lista — así el usuario no tiene que ir a buscarla y pegarla a mano tras conectar.
async function fetchProfile(platform, accessToken) {
  try {
    const cfg = PLATFORMS[platform];
    if (platform === 'twitch') {
      const r = await fetch('https://api.twitch.tv/helix/users', {
        headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId(cfg) },
      });
      if (!r.ok) return { username: null, rtmpUrl: null, login: null };
      const d = await r.json();
      const user = d.data?.[0];
      const username = user?.display_name || user?.login || null;
      const rtmpUrl = user?.id ? await fetchTwitchRtmpUrl(accessToken, cfg, user.id) : null;
      // broadcasterId: Helix exige el id numérico como query param para actualizar el
      // título (channels?broadcaster_id=), a diferencia de Kick que es implícito al token.
      return { username, rtmpUrl, login: user?.login || null, broadcasterId: user?.id || null };
    }
    if (platform === 'youtube') {
      const r = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!r.ok) return { username: null, rtmpUrl: null };
      const d = await r.json();
      const username = d.items?.[0]?.snippet?.title || null;
      const rtmpUrl = await fetchYoutubeRtmpUrl(accessToken);
      return { username, rtmpUrl };
    }
    if (platform === 'kick') {
      const ru = await fetch('https://api.kick.com/public/v1/users', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!ru.ok) return { username: null, rtmpUrl: null, login: null };
      const du = await ru.json();
      const username = du.data?.[0]?.name || null;
      // broadcaster_user_id: lo exige POST /public/v1/chat al enviar como streamer
      // (sendChatMessage) — no se necesitaba antes, el título es implícito al token.
      const broadcasterId = du.data?.[0]?.user_id || null;
      // El chat (Pusher, ver src/chat.js) necesita el slug del canal, no el nombre para
      // mostrar — /public/v1/channels lo trae directo, más confiable que derivarlo del
      // nombre a mano (el slug no siempre es "nombre en minúsculas con guiones").
      let login = null;
      try {
        const rc = await fetch('https://api.kick.com/public/v1/channels', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (rc.ok) {
          const dc = await rc.json();
          login = dc.data?.[0]?.slug || null;
        }
      } catch { /* silent */ }
      // Kick no tiene (todavía) un endpoint público documentado para stream key/RTMP vía
      // OAuth — a diferencia de Twitch/YouTube, acá no se autocompleta, el usuario la pega
      // a mano como siempre. El OAuth solo sirve para conectar cuenta + habilitar el chat.
      return { username, rtmpUrl: null, login, broadcasterId };
    }
  } catch { /* silent */ }
  return { username: null, rtmpUrl: null };
}

async function fetchTwitchRtmpUrl(accessToken, cfg, broadcasterId) {
  try {
    const r = await fetch(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${broadcasterId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId(cfg) },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const key = d.data?.[0]?.stream_key;
    return key ? `rtmp://live.twitch.tv/app/${key}` : null;
  } catch {
    return null;
  }
}

// Trae la clave RTMP "reutilizable" de YouTube Live vía liveStreams.list(mine=true).
// Solo existe si el usuario configuró "Ir en vivo" al menos una vez en YouTube Studio —
// si la lista viene vacía o el scope no alcanza (403), devuelve null y el usuario sigue
// el flujo manual de siempre, sin romper nada.
async function fetchYoutubeRtmpUrl(accessToken) {
  try {
    const r = await fetch(
      'https://www.googleapis.com/youtube/v3/liveStreams?part=cdn&mine=true',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!r.ok) {
      console.log(`[oauth] YouTube: liveStreams.list no accesible (status ${r.status}) — probablemente falta scope o el usuario nunca configuró "Ir en vivo".`);
      return null;
    }
    const d = await r.json();
    console.log(`[oauth] YouTube: liveStreams.list respondió OK, ${d.items?.length || 0} stream(s) encontrado(s).`);
    const info = d.items?.[0]?.cdn?.ingestionInfo;
    if (!info?.streamName || !info?.ingestionAddress) {
      console.log('[oauth] YouTube: sin ingestionInfo — probablemente nunca configuraste "Ir en vivo" en YouTube Studio.');
      return null;
    }
    return `${info.ingestionAddress}/${info.streamName}`;
  } catch (err) {
    console.log(`[oauth] YouTube: fetchYoutubeRtmpUrl lanzó excepción: ${err.message}`);
    return null;
  }
}

// BUNDLED se genera en build time (scripts/generate-oauth-credentials.mjs) a partir de .env,
// en electron/oauth-credentials.js — gitignored, nunca se commitea. Sin ese archivo (dev sin
// build empaquetado) queda vacío y se usa process.env directo (dotenv en `npm run electron`).
let BUNDLED = { TWITCH_CLIENT_ID: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' };
try {
  ({ BUNDLED } = await import('./oauth-credentials.js'));
} catch {
  // No generado — normal en dev.
}

// process.env se lee en tiempo de llamada (no en import) para que userData/.env ya esté cargado.
function clientId(cfg) {
  const key = cfg.envKey || 'UNKNOWN';
  return process.env[`${key}_CLIENT_ID`] || BUNDLED[`${key}_CLIENT_ID`] || '';
}
function clientSecret(cfg) {
  const key = cfg.envKey || 'UNKNOWN';
  return process.env[`${key}_CLIENT_SECRET`] || BUNDLED[`${key}_CLIENT_SECRET`] || '';
}

const REDIRECT_SCHEME = 'muxlyve';

function getRedirectUri(cfg, platform, panelPort) {
  // Twitch exige match EXACTO de string con lo registrado en su consola — usa 'localhost'
  // literal, no '127.0.0.1' (aunque resuelvan al mismo loopback, Twitch los trata distinto).
  return cfg.useLocalhost
    ? `http://localhost:${panelPort}/oauth/${platform}`
    : `${REDIRECT_SCHEME}://oauth/${platform}`;
}

export async function connect(platform, panelPort) {
  const cfg = PLATFORMS[platform];
  if (!cfg) return { ok: false, error: `Plataforma desconocida: ${platform}` };

  const id = clientId(cfg);
  if (!id) {
    return { ok: false, error: `Client ID de ${cfg.name} no configurado. Contacta soporte.` };
  }

  const rUri = getRedirectUri(cfg, platform, panelPort);
  console.log(`[oauth] ${cfg.name}: redirect_uri enviado = ${rUri} — debe coincidir EXACTO con lo registrado en la consola del proveedor.`);
  const state = b64url(randomBytes(16));
  const pkcePair = cfg.pkce ? makePkce() : null;

  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: rUri,
    response_type: 'code',
    scope: cfg.scope,
    state,
  });
  if (pkcePair) {
    params.set('code_challenge', pkcePair.challenge);
    params.set('code_challenge_method', 'S256');
  } else {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { if (!popup.isDestroyed()) popup.close(); } catch {}
      resolve(result);
    };

    const ses = session.fromPartition(`oauth-${platform}-${Date.now()}`, { cache: false });

    const popup = new BrowserWindow({
      width: 520, height: 700,
      title: `Conectar ${cfg.name}`,
      autoHideMenuBar: true,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
    });

    // Intercepta la redirección (http://127.0.0.1 para Twitch, muxlyve:// para otros).
    // Twitch redirige tras el login con un 302 del lado servidor — Electron lo reporta
    // vía 'will-redirect', no 'will-navigate' (ese solo cubre navegaciones iniciadas por
    // usuario/JS). Sin este listener, el popup queda colgado en blanco tras el login.
    // Se escuchan AMBOS eventos porque no siempre se sabe cuál disparará Twitch — pero
    // un mismo redirect puede disparar los dos, y el 'code' de OAuth es de un solo uso:
    // procesarlo dos veces invalida el segundo intento aunque el primero haya sido válido.
    let handled = false;
    const handleRedirect = (event, url) => {
      if (handled || !url.startsWith(rUri)) return;
      handled = true;
      event.preventDefault();
      const u = new URL(url);
      const code = u.searchParams.get('code');
      const oauthError = u.searchParams.get('error');
      const returnedState = u.searchParams.get('state');

      if (oauthError) return finish({ ok: false, error: `OAuth rechazado: ${oauthError}` });
      if (!code || returnedState !== state) {
        return finish({ ok: false, error: 'Respuesta inválida (state mismatch).' });
      }

      exchangeCode(platform, code, rUri, pkcePair?.verifier)
        .then(async (tok) => {
          const { username, rtmpUrl, login, broadcasterId } = await fetchProfile(platform, tok.access_token);
          const all = readTokens();
          all[platform] = {
            access_token: tok.access_token,
            refresh_token: tok.refresh_token || null,
            expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
            username,
            login: login || null,
            broadcasterId: broadcasterId || null,
          };
          writeTokens(all);
          if (platform === 'twitch' && login) startTwitchChat(login);
          if (platform === 'youtube') startYoutubeChat(() => getValidToken('youtube'));
          if (platform === 'kick' && login) startKickChat(login, username);
          finish({ ok: true, username, rtmpUrl });
        })
        .catch((err) => finish({ ok: false, error: err.message }));
    };
    popup.webContents.on('will-navigate', handleRedirect);
    popup.webContents.on('will-redirect', handleRedirect);

    popup.on('closed', () => finish({ ok: false, error: 'Ventana cerrada.' }));
    popup.loadURL(`${cfg.authUrl}?${params}`);
  });
}

export function disconnect(platform) {
  const all = readTokens();
  delete all[platform];
  writeTokens(all);
  if (platform === 'twitch') stopTwitchChat();
  if (platform === 'youtube') stopYoutubeChat();
  if (platform === 'kick') stopKickChat();
  return { ok: true };
}

// Reanuda el chat si ya había una sesión guardada de antes (la app se cerró y volvió a
// abrir) — se llama una vez al arrancar, desde main.js.
export function resumeChatIfConnected() {
  const tokens = readTokens();
  if (tokens.twitch?.login) startTwitchChat(tokens.twitch.login);
  if (tokens.youtube) startYoutubeChat(() => getValidToken('youtube'));
  if (tokens.kick?.login) startKickChat(tokens.kick.login, tokens.kick.username);
}

async function refreshAccessToken(platform) {
  const cfg = PLATFORMS[platform];
  const all = readTokens();
  const tok = all[platform];
  if (!tok?.refresh_token) return null;
  try {
    const params = new URLSearchParams({
      client_id: clientId(cfg),
      refresh_token: tok.refresh_token,
      grant_type: 'refresh_token',
    });
    const secret = clientSecret(cfg);
    if (secret) params.set('client_secret', secret);
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      console.error(`[oauth] ${cfg.name}: fallo al refrescar token (status ${res.status}).`);
      return null;
    }
    const data = await res.json();
    all[platform] = {
      ...tok,
      access_token: data.access_token,
      // Google no siempre reenvía un refresh_token nuevo al refrescar — conserva el viejo.
      refresh_token: data.refresh_token || tok.refresh_token,
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    };
    writeTokens(all);
    return all[platform].access_token;
  } catch (err) {
    console.error(`[oauth] ${cfg.name}: excepción al refrescar token —`, err.message);
    return null;
  }
}

// Usado por el polling de chat de YouTube — refresca proactivamente si el access_token
// está por vencer (margen de 2 min) en vez de esperar a que la API devuelva 401.
export async function getValidToken(platform) {
  const tok = readTokens()[platform];
  if (!tok?.access_token) return null;
  const nearExpiry = tok.expires_at && Date.now() > tok.expires_at - 120000;
  return nearExpiry ? refreshAccessToken(platform) : tok.access_token;
}

export function getStatus() {
  const all = readTokens();
  const result = {};
  for (const p of ['twitch', 'youtube', 'kick', 'tiktok']) {
    const t = all[p];
    result[p] = t ? { connected: true, username: t.username || null } : { connected: false };
  }
  return result;
}

export function getToken(platform) {
  return readTokens()[platform] || null;
}

// Título global — aplica el mismo título a las plataformas conectadas que lo soportan.
// YouTube queda fuera a propósito: necesita scope 'youtube'/'youtube.force-ssl' (mucho más
// amplio que el 'youtube.readonly' actual) y tocar eso ahora complicaría la revisión de
// verificación OAuth de Google que ya está pendiente — se retoma cuando la aprueben.
const TITLE_SYNC_PLATFORMS = ['twitch', 'kick'];

// Busca la categoría por nombre y devuelve el id — Twitch/Kick exigen un id numérico
// interno, no aceptan el nombre libre en el PATCH del canal.
async function findTwitchCategoryId(category, token) {
  const res = await fetch(`https://api.twitch.tv/helix/search/categories?query=${encodeURIComponent(category)}&first=1`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId(PLATFORMS.twitch) },
  });
  if (!res.ok) return null;
  const d = await res.json();
  return d.data?.[0]?.id || null;
}

async function findKickCategoryId(category, token) {
  const res = await fetch(`https://api.kick.com/public/v2/categories?name[]=${encodeURIComponent(category)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const d = await res.json();
  return d.data?.[0]?.id || null;
}

async function setTwitchTitle(title, category) {
  const cfg = PLATFORMS.twitch;
  const tok = readTokens().twitch;
  if (!tok?.broadcasterId) return { ok: false, error: 'Falta broadcasterId — reconecta Twitch.' };
  const token = await getValidToken('twitch');
  if (!token) return { ok: false, error: 'Sesión de Twitch inválida — reconecta.' };
  // Solo se manda lo que realmente cambió — mandar title:'' borraría el título existente.
  const body = {};
  if (title) body.title = title;
  if (category) {
    const gameId = await findTwitchCategoryId(category, token);
    if (!gameId) return { ok: false, error: `Categoría "${category}" no encontrada en Twitch.` };
    body.game_id = gameId;
  }
  if (!Object.keys(body).length) return { ok: false, error: 'Nada que actualizar.' };
  const res = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${tok.broadcasterId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId(cfg),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `Twitch ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

async function setKickTitle(title, category) {
  const token = await getValidToken('kick');
  if (!token) return { ok: false, error: 'Sesión de Kick inválida — reconecta.' };
  const body = {};
  if (title) body.stream_title = title;
  if (category) {
    const categoryId = await findKickCategoryId(category, token);
    if (!categoryId) return { ok: false, error: `Categoría "${category}" no encontrada en Kick.` };
    body.category_id = categoryId;
  }
  if (!Object.keys(body).length) return { ok: false, error: 'Nada que actualizar.' };
  const res = await fetch('https://api.kick.com/public/v1/channels', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `Kick ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

// Aplica título + categoría a todas las plataformas conectadas que lo soportan — devuelve
// un resultado por plataforma para que la UI muestre exactamente cuál falló, si alguna falla.
export async function setStreamTitle(title, category) {
  const tokens = readTokens();
  const results = {};
  for (const platform of TITLE_SYNC_PLATFORMS) {
    if (!tokens[platform]) continue; // no conectado — se omite en silencio, no es error
    try {
      results[platform] = platform === 'twitch' ? await setTwitchTitle(title, category) : await setKickTitle(title, category);
    } catch (err) {
      results[platform] = { ok: false, error: err.message };
    }
  }
  return results;
}

// ── Espectadores por plataforma ─────────────────────────────────────────────────────
// Solo lectura, no necesita scopes nuevos (channel:read/user:read ya alcanzan) — a
// diferencia del título o la moderación, esto SÍ se puede sumar YouTube sin tocar el
// scope pendiente de revisión de Google (youtube.readonly ya cubre streams.list).
const VIEWER_POLL_MS = 30000;

async function fetchTwitchViewers() {
  const tok = readTokens().twitch;
  if (!tok?.broadcasterId) return null;
  const token = await getValidToken('twitch');
  if (!token) return null;
  const res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${tok.broadcasterId}`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId(PLATFORMS.twitch) },
  });
  if (!res.ok) return null;
  const d = await res.json();
  const stream = d.data?.[0];
  return { live: !!stream, count: stream?.viewer_count ?? 0 };
}

async function fetchKickViewers() {
  const token = await getValidToken('kick');
  if (!token) return null;
  const res = await fetch('https://api.kick.com/public/v1/channels', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const d = await res.json();
  const stream = d.data?.[0]?.stream;
  return { live: !!stream?.is_live, count: stream?.viewer_count ?? 0 };
}

async function fetchYoutubeViewers() {
  const token = await getValidToken('youtube');
  if (!token) return null;
  try {
    const rb = await fetch(
      'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id&broadcastStatus=active&broadcastType=all',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!rb.ok) return null;
    const db = await rb.json();
    const videoId = db.items?.[0]?.id;
    if (!videoId) return { live: false, count: 0 };
    const rv = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!rv.ok) return null;
    const dv = await rv.json();
    const n = dv.items?.[0]?.liveStreamingDetails?.concurrentViewers;
    return { live: true, count: n != null ? Number(n) : 0 };
  } catch { return null; }
}

async function pollViewerCounts() {
  const tokens = readTokens();
  const next = {};
  if (tokens.twitch) { const v = await fetchTwitchViewers(); if (v) next.twitch = v; }
  if (tokens.kick) { const v = await fetchKickViewers(); if (v) next.kick = v; }
  if (tokens.youtube) { const v = await fetchYoutubeViewers(); if (v) next.youtube = v; }
  setViewerCounts(next);
}

setInterval(pollViewerCounts, VIEWER_POLL_MS);
pollViewerCounts();

// ── Modo lento / solo emotes ─────────────────────────────────────────────────────────
// Solo Twitch — Kick no expone esto en su API pública (revisado: moderation.md documenta
// únicamente ban/unban, nada de ajustes de chat a nivel canal). YouTube tampoco se toca
// acá, mismo criterio que el título (scope más amplio, revisión de Google pendiente).
export async function setTwitchChatMode({ emoteOnly, slowSeconds, subscriberOnly }) {
  const tok = readTokens().twitch;
  if (!tok?.broadcasterId) return { ok: false, error: 'Falta broadcasterId — reconecta Twitch.' };
  const token = await getValidToken('twitch');
  if (!token) return { ok: false, error: 'Sesión de Twitch inválida — reconecta.' };
  const body = { emote_mode: !!emoteOnly, slow_mode: !!slowSeconds, subscriber_mode: !!subscriberOnly };
  if (slowSeconds) body.slow_mode_wait_time = slowSeconds;
  const res = await fetch(
    `https://api.twitch.tv/helix/chat/settings?broadcaster_id=${tok.broadcasterId}&moderator_id=${tok.broadcasterId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Client-Id': clientId(PLATFORMS.twitch),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `Twitch ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}
setChatModeHandler(setTwitchChatMode);

// ── Enviar mensaje como el streamer ─────────────────────────────────────────────────
// Mismo patrón que el título: aplica a las plataformas conectadas que lo soporten.
// YouTube queda fuera — mismo criterio que el título/moderación (scope más amplio,
// revisión de Google pendiente).
const CHAT_SEND_PLATFORMS = ['twitch', 'kick'];

async function sendTwitchMessage(text) {
  const tok = readTokens().twitch;
  if (!tok?.broadcasterId) return { ok: false, error: 'Falta broadcasterId — reconecta Twitch.' };
  const token = await getValidToken('twitch');
  if (!token) return { ok: false, error: 'Sesión de Twitch inválida — reconecta.' };
  const res = await fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId(PLATFORMS.twitch),
      'Content-Type': 'application/json',
    },
    // El streamer manda como sí mismo: sender_id = broadcaster_id.
    body: JSON.stringify({ broadcaster_id: tok.broadcasterId, sender_id: tok.broadcasterId, message: text }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { ok: false, error: `Twitch ${res.status}: ${t.slice(0, 200)}` };
  }
  return { ok: true };
}

async function sendKickMessage(text) {
  const tok = readTokens().kick;
  const token = await getValidToken('kick');
  if (!token) return { ok: false, error: 'Sesión de Kick inválida — reconecta.' };
  const body = { content: text, type: 'user' };
  if (tok?.broadcasterId) body.broadcaster_user_id = tok.broadcasterId;
  const res = await fetch('https://api.kick.com/public/v1/chat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { ok: false, error: `Kick ${res.status}: ${t.slice(0, 200)}` };
  }
  return { ok: true };
}

export async function sendChatMessage(text) {
  const tokens = readTokens();
  const results = {};
  for (const platform of CHAT_SEND_PLATFORMS) {
    if (!tokens[platform]) continue;
    try {
      results[platform] = platform === 'twitch' ? await sendTwitchMessage(text) : await sendKickMessage(text);
    } catch (err) {
      results[platform] = { ok: false, error: err.message };
    }
  }
  return results;
}
setChatSendHandler(sendChatMessage);

// ── Fijar mensaje ────────────────────────────────────────────────────────────────────
// Solo Twitch tiene esto como API pública real (POST /helix/chat/messages/pin, scope
// moderator:manage:chat_messages). Kick sí lo tiene en su web, pero es un endpoint interno
// (api/internal/v1/...) no expuesto a apps de terceros — mismo caso que el modo lento/solo-
// emotes de Kick, ver AskUserQuestion anterior. YouTube no tiene nada de esto en su API
// pública (liveChatMessages solo trae list/insert/delete/transition, ningún pin).
export async function pinTwitchMessage(messageId) {
  if (!messageId) return { ok: false, error: 'Mensaje sin id — no se puede fijar.' };
  const tok = readTokens().twitch;
  if (!tok?.broadcasterId) return { ok: false, error: 'Falta broadcasterId — reconecta Twitch.' };
  const token = await getValidToken('twitch');
  if (!token) return { ok: false, error: 'Sesión de Twitch inválida — reconecta.' };
  const res = await fetch('https://api.twitch.tv/helix/chat/messages/pin', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId(PLATFORMS.twitch),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ broadcaster_id: tok.broadcasterId, message_id: messageId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `Twitch ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}
setChatPinHandler(pinTwitchMessage);
