// Desarrollado por NABA-OL
import { BrowserWindow, safeStorage, app, session } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const PLATFORMS = {
  twitch: {
    name: 'Twitch',
    authUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scope: 'user:read:email channel:read:subscriptions channel:read:stream_key',
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
      if (!r.ok) return { username: null, rtmpUrl: null };
      const d = await r.json();
      const user = d.data?.[0];
      const username = user?.display_name || user?.login || null;
      const rtmpUrl = user?.id ? await fetchTwitchRtmpUrl(accessToken, cfg, user.id) : null;
      return { username, rtmpUrl };
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
          const { username, rtmpUrl } = await fetchProfile(platform, tok.access_token);
          const all = readTokens();
          all[platform] = {
            access_token: tok.access_token,
            refresh_token: tok.refresh_token || null,
            expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
            username,
          };
          writeTokens(all);
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
  return { ok: true };
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
