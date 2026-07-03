// Desarrollado por NABA-OL
// Fase B — Activación y validación de licencia.
// Flujo: activate once online → store signed token → revalidate every 30d.
// Offline grace: 7 extra days if backend unreachable.
// Dev bypass: !isPackaged or MS_DEV_UNLOCK=1 → always unlocked.

import { safeStorage, app } from "electron";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LICENSE_API = process.env.MS_LICENSE_API || "https://muxlyve.com";

const GRACE_DAYS = 30; // días sin revalidar online
const OFFLINE_EXTRA = 7; // días extra si el backend no responde

function dataPath(filename) {
  return path.join(app.getPath("userData"), filename);
}

// Machine ID persistente: UUID generado en el primer arranque.
// Si el usuario reinstala el SO, obtiene un nuevo ID y puede reactivar.
export function getMachineId() {
  const p = dataPath("machine-id.json");
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8")).id;
    } catch {}
  }
  const id = randomUUID();
  writeFileSync(p, JSON.stringify({ id }), "utf8");
  return id;
}

// Cifrado con safeStorage (DPAPI en Windows, Keychain en Mac).
// Fallback a texto plano si el sistema no tiene llavero disponible.
function saveLicense(data) {
  const json = JSON.stringify(data);
  const p = dataPath("license.enc");
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(p, safeStorage.encryptString(json));
  } else {
    writeFileSync(p, json, "utf8");
  }
}

export function loadLicense() {
  const p = dataPath("license.enc");
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p);
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function clearLicense() {
  const p = dataPath("license.enc");
  if (existsSync(p)) unlinkSync(p);
}

async function apiPost(endpoint, body) {
  const res = await fetch(`${LICENSE_API}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || `HTTP ${res.status}`), {
      status: res.status,
      data: err,
    });
  }
  return res.json();
}

// Contrato esperado del backend:
//   POST /api/licenses/activate  → { valid, token, email }
//   POST /api/licenses/validate  → { valid, reason? }
//   POST /api/licenses/release   → { ok }

export async function checkLicense({ isPackaged }) {
  if (!isPackaged && process.env.MS_FORCE_LICENSE !== "1")
    return { unlocked: true, reason: "dev" };
  if (!isPackaged && process.env.MS_DEV_UNLOCK === "1")
    return { unlocked: true, reason: "env" };

  const stored = loadLicense();
  if (!stored) return { unlocked: false, reason: "no-license" };

  // Validar online en cada arranque. El período de gracia solo aplica sin red.
  try {
    const result = await apiPost("/api/licenses/validate", {
      key: stored.key,
      token: stored.token,
      machineId: getMachineId(),
    });
    if (result.valid) {
      const newStatus = result.status || stored.status;
      saveLicense({
        ...stored,
        validatedAt: Date.now(),
        plan: result.plan || stored.plan,
        status: newStatus,
        expiresAt: "expiresAt" in result ? result.expiresAt : stored.expiresAt,
        renewsAt: "renewsAt" in result ? result.renewsAt : stored.renewsAt,
      });
      if (newStatus === "cancelled") {
        return { unlocked: false, reason: "subscription-cancelled" };
      }
      return { unlocked: true, reason: "online", email: stored.email };
    }
    return { unlocked: false, reason: result.reason || "invalid" };
  } catch {
    // Sin red: usar estado en caché.
    if (stored.status === "cancelled") {
      return { unlocked: false, reason: "subscription-cancelled" };
    }
    // Vitalicio: acceso offline indefinido (no hay renovación que confirmar).
    if (stored.plan === "lifetime") {
      return {
        unlocked: true,
        reason: "offline-lifetime",
        email: stored.email,
      };
    }
    // Suscripción mensual/anual: si renewsAt ya pasó y no se pudo confirmar renovación → bloquear.
    if (stored.renewsAt && Date.now() > stored.renewsAt) {
      return { unlocked: false, reason: "renewal-unconfirmed" };
    }
    // Dentro del período pagado sin red: gracia de 37 días desde la última validación.
    const daysSince = (Date.now() - (stored.validatedAt ?? 0)) / 86400000;
    if (daysSince < GRACE_DAYS + OFFLINE_EXTRA) {
      return { unlocked: true, reason: "offline-grace", email: stored.email };
    }
    return { unlocked: false, reason: "offline-expired" };
  }
}

export async function activateLicense(key) {
  try {
    const result = await apiPost("/api/licenses/activate", {
      key: key.trim(),
      machineId: getMachineId(),
      version: app.getVersion(),
    });
    if (result.valid && result.token) {
      const now = Date.now();
      saveLicense({
        key: key.trim(),
        token: result.token,
        email: result.email || "",
        plan: result.plan || "lifetime",
        status: result.status || "active",
        expiresAt: result.expiresAt ?? null,
        renewsAt: result.renewsAt ?? null,
        activatedAt: now,
        validatedAt: now,
      });
      return { ok: true, email: result.email || "" };
    }
    return {
      ok: false,
      error:
        result.error ||
        result.message ||
        "Licencia inválida o ya activa en otro equipo.",
    };
  } catch (err) {
    console.error(
      "[license] activate error:",
      err.status,
      err.message,
      err.data,
    );
    if (err.status === 409)
      return {
        ok: false,
        error:
          "Esta licencia ya está activa en otro equipo. Libérala primero desde el otro equipo.",
      };
    if (err.status === 404)
      return {
        ok: false,
        error: "Clave no encontrada. Revisa que la copiaste bien.",
      };
    if (err.status === 402)
      return {
        ok: false,
        error:
          "Tu suscripción fue cancelada o venció. Renuévala para activar Muxlyve.",
      };
    const errBody = (
      err.data?.error ||
      err.data?.message ||
      err.message ||
      ""
    ).toLowerCase();
    if (
      errBody.includes("cancel") ||
      errBody.includes("inactive") ||
      errBody.includes("suspend") ||
      errBody.includes("expired")
    ) {
      return {
        ok: false,
        error:
          "Tu suscripción fue cancelada o venció. Renuévala para activar Muxlyve.",
      };
    }
    if (err.status >= 400 && err.status < 500)
      return { ok: false, error: "Clave inválida o suscripción inactiva." };
    return {
      ok: false,
      error:
        "No se pudo conectar al servidor. Revisa tu internet e intenta de nuevo.",
    };
  }
}

export async function releaseLicense() {
  const stored = loadLicense();
  if (!stored) return { ok: true };
  try {
    await apiPost("/api/licenses/release", {
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
    plan: stored.plan || "lifetime",
    status: stored.status || "active",
    expiresAt: stored.expiresAt || null,
    renewsAt: stored.renewsAt || null,
    activatedAt: stored.activatedAt,
    machineId: getMachineId(),
  };
}

export async function refreshLicenseStatus() {
  const stored = loadLicense();
  if (!stored) return null;
  const machineId = getMachineId();
  const body = { key: stored.key, token: stored.token, machineId };

  // Intenta endpoint dedicado primero; si no existe, cae a validate.
  for (const endpoint of ["/api/licenses/status", "/api/licenses/validate"]) {
    try {
      const result = await apiPost(endpoint, body);
      if (result.plan || result.status || result.valid !== undefined) {
        saveLicense({
          ...stored,
          plan: result.plan || stored.plan,
          status: result.status || stored.status,
          expiresAt:
            "expiresAt" in result ? result.expiresAt : stored.expiresAt,
          renewsAt: "renewsAt" in result ? result.renewsAt : stored.renewsAt,
        });
        break;
      }
    } catch {
      /* continúa al siguiente */
    }
  }
  return getLicenseInfo();
}
