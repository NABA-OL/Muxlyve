// Fase B — Activación y validación de licencia.
// Flujo: activate once online → store signed token → revalidate every 30d.
// Offline grace: 7 extra days if backend unreachable.
// Dev bypass: !isPackaged or MS_DEV_UNLOCK=1 → always unlocked.

import { safeStorage, app } from 'electron';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Backend de licencias — actualizar cuando la web esté desplegada.
const LICENSE_API = process.env.MS_LICENSE_API || 'https://api.multi-stream.app';

const GRACE_DAYS = 30;       // días sin revalidar online
const OFFLINE_EXTRA = 7;     // días extra si el backend no responde

function dataPath(filename) {
  return path.join(app.getPath('userData'), filename);
}

// Machine ID persistente: UUID generado en el primer arranque.
// Si el usuario reinstala el SO, obtiene un nuevo ID y puede reactivar.
export function getMachineId() {
  const p = dataPath('machine-id.json');
  if (existsSync(p)) {
    try { return JSON.parse(readFileSync(p, 'utf8')).id; } catch {}
  }
  const id = randomUUID();
  writeFileSync(p, JSON.stringify({ id }), 'utf8');
  return id;
}

// Cifrado con safeStorage (DPAPI en Windows, Keychain en Mac).
// Fallback a texto plano si el sistema no tiene llavero disponible.
function saveLicense(data) {
  const json = JSON.stringify(data);
  const p = dataPath('license.enc');
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(p, safeStorage.encryptString(json));
  } else {
    writeFileSync(p, json, 'utf8');
  }
}

export function loadLicense() {
  const p = dataPath('license.enc');
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p);
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    return JSON.parse(json);
  } catch { return null; }
}

function clearLicense() {
  const p = dataPath('license.enc');
  if (existsSync(p)) unlinkSync(p);
}

async function apiPost(endpoint, body) {
  const res = await fetch(`${LICENSE_API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || `HTTP ${res.status}`), { status: res.status, data: err });
  }
  return res.json();
}

// Contrato esperado del backend:
//   POST /api/licenses/activate  → { valid, token, email }
//   POST /api/licenses/validate  → { valid, reason? }
//   POST /api/licenses/release   → { ok }

export async function checkLicense({ isPackaged }) {
  if (!isPackaged) return { unlocked: true, reason: 'dev' };
  if (process.env.MS_DEV_UNLOCK === '1') return { unlocked: true, reason: 'env' };

  const stored = loadLicense();
  if (!stored) return { unlocked: false, reason: 'no-license' };

  const daysSince = (Date.now() - (stored.validatedAt ?? 0)) / 86400000;

  // Dentro del período de gracia: sin red.
  if (daysSince < GRACE_DAYS) {
    return { unlocked: true, reason: 'cached', email: stored.email };
  }

  // Período vencido: revalidar online.
  try {
    const result = await apiPost('/api/licenses/validate', {
      key: stored.key,
      token: stored.token,
      machineId: getMachineId(),
    });
    if (result.valid) {
      saveLicense({ ...stored, validatedAt: Date.now() });
      return { unlocked: true, reason: 'online', email: stored.email };
    }
    return { unlocked: false, reason: result.reason || 'invalid' };
  } catch {
    // Sin internet: gracia extra antes de bloquear.
    if (daysSince < GRACE_DAYS + OFFLINE_EXTRA) {
      return { unlocked: true, reason: 'offline-grace', email: stored.email };
    }
    return { unlocked: false, reason: 'offline-expired' };
  }
}

export async function activateLicense(key) {
  try {
    const result = await apiPost('/api/licenses/activate', {
      key: key.trim().toUpperCase(),
      machineId: getMachineId(),
      version: app.getVersion(),
    });
    if (result.valid && result.token) {
      const now = Date.now();
      saveLicense({
        key: key.trim().toUpperCase(),
        token: result.token,
        email: result.email || '',
        activatedAt: now,
        validatedAt: now,
      });
      return { ok: true, email: result.email || '' };
    }
    return { ok: false, error: result.error || result.message || 'Licencia inválida o ya activa en otro equipo.' };
  } catch (err) {
    if (err.status === 409) return { ok: false, error: 'Esta licencia ya está activa en otro equipo. Libérala primero desde el otro equipo.' };
    if (err.status === 404) return { ok: false, error: 'Clave no encontrada. Revisa que la copiaste bien.' };
    return { ok: false, error: 'No se pudo conectar al servidor. Revisa tu internet e intenta de nuevo.' };
  }
}

export async function releaseLicense() {
  const stored = loadLicense();
  if (!stored) return { ok: true };
  try {
    await apiPost('/api/licenses/release', {
      key: stored.key,
      token: stored.token,
      machineId: getMachineId(),
    });
  } catch {
    // Liberar localmente aunque el backend falle (permite reactivar en otro equipo).
  }
  clearLicense();
  return { ok: true };
}

export function getLicenseInfo() {
  const stored = loadLicense();
  if (!stored) return null;
  return {
    key: stored.key,
    email: stored.email,
    activatedAt: stored.activatedAt,
    machineId: getMachineId(),
  };
}
