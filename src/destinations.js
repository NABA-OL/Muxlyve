// Desarrollado por NABA-OL
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

// --- Cifrado en reposo (AES-256-GCM) ---
// Clave maestra desde .env. Si no está, se guarda en texto plano (con aviso) para
// no romper el uso actual; en cuanto se define MASTER_KEY, el próximo guardado cifra.
const MASTER_KEY = process.env.MASTER_KEY || '';
// scrypt deriva 32 bytes. Salt fijo: la entropía la aporta MASTER_KEY, que ya es secreta.
const cryptoKey = MASTER_KEY ? scryptSync(MASTER_KEY, 'multistream-salt-v1', 32) : null;
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

// Pasa un destino del disco a memoria: descifra urlEnc -> url (texto plano en memoria).
function decode(d) {
  if (d.urlEnc) {
    if (!cryptoKey) {
      console.warn(`[crypto] ${d.name}: clave cifrada pero falta MASTER_KEY en .env`);
      return { ...d, url: '', urlEnc: undefined };
    }
    try {
      return { ...d, url: decrypt(d.urlEnc), urlEnc: undefined };
    } catch {
      console.error(`[crypto] ${d.name}: no se pudo descifrar (¿MASTER_KEY incorrecta?)`);
      return { ...d, url: '', urlEnc: undefined };
    }
  }
  return d; // texto plano (legado / ejemplo)
}

// Pasa un destino de memoria al disco: cifra url -> urlEnc si hay MASTER_KEY.
function encode(d) {
  const { urlEnc, ...rest } = d;
  if (cryptoKey && rest.url) {
    const { url, ...noUrl } = rest;
    return { ...noUrl, urlEnc: encrypt(url) };
  }
  if (!cryptoKey && !warnedPlain) {
    console.warn('[crypto] MASTER_KEY no definida: las claves se guardan en TEXTO PLANO. Define MASTER_KEY en .env para cifrarlas.');
    warnedPlain = true;
  }
  return rest;
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
