import { BrowserWindow, safeStorage, app, session } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const PLATFORMS = {
  twitch: {
    name: 'Twitch',
    authUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scope: 'user:read:email channel:read:subscriptions',
    pkce: true,
  },
  youtube: {
    name: 'YouTube',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    pkce: false,
    envKey: 'GOOGLE',
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
  const envKey = cfg.envKey || platform.toUpperCase();
  const clientId = process.env[`${envKey}_CLIENT_ID`] || '';
  const clientSecret = process.env[`${envKey}_CLIENT_SECRET`] || '';

  const params = new URLSearchParams({
    client_id: clientId,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  if (cfg.pkce) {
    params.set('code_verifier', verifier);
  } else {
    params.set('client_secret', clientSecret);
  }

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchUsername(platform, accessToken) {
  try {
    const clientId = process.env[`${platform.toUpperCase()}_CLIENT_ID`] || '';
    if (platform === 'twitch') {
      const r = await fetch('https://api.twitch.tv/helix/users', {
        headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId },
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d.data?.[0]?.display_name || d.data?.[0]?.login || null;
    }
    if (platform === 'youtube') {
      const r = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!r.ok) return null;
      const d = await r.json();
      return d.items?.[0]?.snippet?.title || null;
    }
  } catch { /* silent */ }
  return null;
}

export async function connect(platform, panelPort) {
  const cfg = PLATFORMS[platform];
  if (!cfg) return { ok: false, error: `Plataforma desconocida: ${platform}` };

  const envKey = cfg.envKey || platform.toUpperCase();
  const clientId = process.env[`${envKey}_CLIENT_ID`] || '';
  if (!clientId) {
    return { ok: false, error: `${envKey}_CLIENT_ID no configurado en .env` };
  }

  const redirectUri = `http://127.0.0.1:${panelPort}/oauth/${platform}`;
  const state = b64url(randomBytes(16));
  const pkcePair = cfg.pkce ? makePkce() : null;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
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

    // Isolated session: intercepts only the redirect URI, no cookie sharing with main session.
    const ses = session.fromPartition(`oauth-${platform}-${Date.now()}`, { cache: false });

    ses.webRequest.onBeforeRequest({ urls: [`${redirectUri}*`] }, (details, callback) => {
      callback({ cancel: true });
      const u = new URL(details.url);
      const code = u.searchParams.get('code');
      const oauthError = u.searchParams.get('error');
      const returnedState = u.searchParams.get('state');

      if (oauthError) return finish({ ok: false, error: `OAuth rechazado: ${oauthError}` });
      if (!code || returnedState !== state) {
        return finish({ ok: false, error: 'Respuesta inválida (state mismatch).' });
      }

      exchangeCode(platform, code, redirectUri, pkcePair?.verifier)
        .then(async (tok) => {
          const username = await fetchUsername(platform, tok.access_token);
          const all = readTokens();
          all[platform] = {
            access_token: tok.access_token,
            refresh_token: tok.refresh_token || null,
            expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
            username,
          };
          writeTokens(all);
          finish({ ok: true, username });
        })
        .catch((err) => finish({ ok: false, error: err.message }));
    });

    const popup = new BrowserWindow({
      width: 520, height: 700,
      title: `Conectar ${cfg.name}`,
      autoHideMenuBar: true,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
    });

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
