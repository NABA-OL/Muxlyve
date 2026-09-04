/*
 * Propiedad de BlacKraken Solutions <blackraken.com>
 * Desarrollado por: NABAOL
 * Fecha de creación: 2026-07-01
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// MS_CONFIG_DIR permite escribir el config fuera del paquete (la app Electron lo
// apunta a userData, porque src/ va dentro de app.asar de solo lectura).
const CONFIG_DIR = process.env.MS_CONFIG_DIR || path.join(__dirname, '..', 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'destinations.json');
const EXAMPLE_PATH = path.join(__dirname, '..', 'config', 'destinations.example.json');

const PLACEHOLDERS = ['TU_CLAVE', 'CLAVE_TEMPORAL', 'SERVIDOR_TIKTOK'];
const SALT_PATH = path.join(CONFIG_DIR, 'crypto-salt.json');
// Salt fijo que usaban TODAS las instalaciones antes de este fix (CN-020) — hay que
// seguir generando la misma clave con él para quien ya tenga destinations.json cifrado
// de una versión anterior, si no esos datos quedan indescifrables para siempre.
const LEGACY_SALT = 'multistream-salt-v1';

// CN-020: salt por instalación en vez de uno fijo compartido por TODAS las instalaciones
// — un MASTER_KEY débil/corto ya no es atacable con una tabla precomputada válida para
// cualquier usuario, hay que calcularla de nuevo por instalación. No necesita ser secreto
// (la entropía real la sigue aportando MASTER_KEY), solo distinto por instalación y
// estable entre reinicios — mismo patrón que getOrCreatePanelToken().
// Migración: si destinations.json YA existe (pudo haberse cifrado con LEGACY_SALT en una
// versión anterior), el salt persistido arranca en LEGACY_SALT — solo una instalación
// genuinamente nueva (sin destinations.json todavía) arranca con un salt random real.
function getOrCreateSalt() {
  try {
    if (existsSync(SALT_PATH)) {
      const { salt } = JSON.parse(readFileSync(SALT_PATH, 'utf8'));
      if (salt) return salt;
    }
  } catch {}
  const salt = existsSync(CONFIG_PATH) ? LEGACY_SALT : randomBytes(16).toString('base64url');
  try {
    writeFileSync(SALT_PATH, JSON.stringify({ salt }, null, 2));
  } catch (err) {
    console.error('[crypto] No se pudo guardar el salt en disco:', err.message);
  }
  return salt;
}

// --- Cifrado en reposo (AES-256-GCM) ---
// Clave maestra desde .env. Si no está, se guarda en texto plano (con aviso) para
// no romper el uso actual; en cuanto se define MASTER_KEY, el próximo guardado cifra.
const MASTER_KEY = process.env.MASTER_KEY || '';
// scrypt deriva 32 bytes.
const cryptoKey = MASTER_KEY ? scryptSync(MASTER_KEY, getOrCreateSalt(), 32) : null;
let warnedPlain = false;

function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cryptoKey, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(enc) {
  const decipher = createDecipheriv('aes-256-gcm', cryptoKey, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]).toString('utf8');
}

// Descifra un solo campo *Enc -> su nombre en claro, con el mismo fallback que decode()
// (clave faltante o incorrecta -> string vacío, nunca revienta la carga del resto).
function decryptField(d, encField, plainField) {
  if (!d[encField]) return d[plainField] ?? '';
  if (!cryptoKey) {
    console.warn(`[crypto] ${d.name}: clave cifrada (${plainField}) pero falta MASTER_KEY en .env`);
    return '';
  }
  try {
    return decrypt(d[encField]);
  } catch {
    console.error(`[crypto] ${d.name}: no se pudo descifrar ${plainField} (¿MASTER_KEY incorrecta?)`);
    return '';
  }
}

// Pasa un destino del disco a memoria: descifra urlEnc/verticalUrlEnc -> texto plano.
function decode(d) {
  const { urlEnc, verticalUrlEnc, ...rest } = d;
  return {
    ...rest,
    url: decryptField(d, 'urlEnc', 'url'),
    verticalUrl: decryptField(d, 'verticalUrlEnc', 'verticalUrl'),
  };
}

// Pasa un destino de memoria al disco: cifra url/verticalUrl -> *Enc si hay MASTER_KEY.
function encode(d) {
  const { urlEnc, verticalUrlEnc, url, verticalUrl, ...rest } = d;
  if (cryptoKey) {
    const out = { ...rest };
    if (url) out.urlEnc = encrypt(url);
    if (verticalUrl) out.verticalUrlEnc = encrypt(verticalUrl);
    return out;
  }
  if (!warnedPlain) {
    console.warn('[crypto] MASTER_KEY no definida: las claves se guardan en TEXTO PLANO. Define MASTER_KEY en .env para cifrarlas.');
    warnedPlain = true;
  }
  return { ...rest, ...(url ? { url } : {}), ...(verticalUrl ? { verticalUrl } : {}) };
}

// Valida que la URL sea un destino RTMP real y no un placeholder de la plantilla.
export function isValidUrl(url) {
  if (typeof url !== 'string') return false;
  if (!/^(rtmps?|srt):\/\//i.test(url)) return false;
  return !PLACEHOLDERS.some((p) => url.includes(p));
}

// Un destino se reenvía si está habilitado y su URL es válida.
export function isPlayable(dest) {
  return Boolean(dest && dest.enabled && isValidUrl(dest.url));
}

// Mismo criterio que isPlayable(), para el canal vertical (segunda conexión RTMP
// independiente hacia la URL/clave vertical de la plataforma — ver CLAUDE.md, "Dual-format
// vertical"). Campo separado (verticalEnabled/verticalUrl) para poder prender/apagar cada
// orientación por separado sin que una dependa de la otra.
export function isPlayableVertical(dest) {
  return Boolean(dest && dest.verticalEnabled && isValidUrl(dest.verticalUrl));
}

// Lee la lista completa (incluye deshabilitados/incompletos), con url descifrada en memoria.
export function loadAll() {
  if (!existsSync(CONFIG_PATH)) {
    // Primera ejecución en este perfil: semilla desde el ejemplo y lo ancla en userData
    // para que reinstalaciones futuras encuentren el archivo (con las ediciones del usuario).
    try {
      const data = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf-8'));
      const list = Array.isArray(data.destinations) ? data.destinations : [];
      try { saveAll(list); } catch { /* si userData no es escribible, continúa en memoria */ }
      return list.map(decode);
    } catch (err) {
      console.error('[config] No se pudo leer destinations.example.json:', err.message);
      return [];
    }
  }
  try {
    const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    const list = Array.isArray(data.destinations) ? data.destinations : [];
    return list.map(decode);
  } catch (err) {
    console.error('[config] No se pudo leer destinations.json:', err.message);
    return [];
  }
}

// Escribe la lista completa en config/destinations.json (cifrando si hay MASTER_KEY).
export function saveAll(destinations) {
  const out = destinations.map(encode);
  writeFileSync(CONFIG_PATH, JSON.stringify({ destinations: out }, null, 2) + '\n', 'utf-8');
}
