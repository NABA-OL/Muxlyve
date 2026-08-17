/*
 * Propiedad de BlacKraken Solutions
 * Desarrollado por: NABAOL
 * Fecha de creación: [FECHA_ACTUAL: 2026-08-08]
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
// Traducción de mensajes de chat — pega al endpoint no-oficial de Google Translate
// (translate.googleapis.com/translate_a/single). NO es una API soportada ni documentada
// por Google, es el mismo truco que usan varias apps chiquitas para traducir gratis sin
// pedirle una API key al usuario — puede cambiar de forma o cortarse sin aviso, sin SLA.
// A propósito NO se usa para nada crítico (nunca bloquea ni retrasa el chat en vivo, ver
// src/chat.js) — si un día deja de responder, el chat sigue andando igual, solo sin
// traducción. Detrás de un toggle apagado por defecto (chatTranslateEnabled en
// settings.js) — quien lo prenda entiende que es un best-effort, no una garantía.
const CACHE_MAX = 200;
const cache = new Map(); // "texto|idioma" -> { translated, detectedLang }
const MAX_TEXT_LEN = 500; // mensajes más largos no se traducen — ni tiene sentido para chat

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); } // mueve al final (más reciente)
  return hit;
}
function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // el más viejo
  cache.set(key, value);
}

// Respuesta cruda de este endpoint es un array anidado sin nombres de campo — algo como
// [[["hola","hello",null,null,1]], null, "en"] — el texto traducido vive en
// data[0][*][0] (concatenado, puede venir partido en varias oraciones) y el idioma
// detectado en data[2] o data[8]?.[0]?.[0] según la variante de respuesta.
function parseGoogleResponse(data) {
  const translated = (data[0] || []).map((chunk) => chunk[0]).join('');
  const detectedLang = data[2] || data[8]?.[0]?.[0] || null;
  return { translated, detectedLang };
}

// text: mensaje original. targetLang: 'es'|'en'|'fr'|'pt' (mismos que soporta el panel).
// Devuelve null si falla, el idioma detectado es inválido, o el texto ya está en el
// idioma destino (nada que traducir) — el llamador decide qué hacer con null.
export async function translateText(text, targetLang) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed || trimmed.length > MAX_TEXT_LEN) return null;
  const key = trimmed + '|' + targetLang;
  const cached = cacheGet(key);
  if (cached) return cached.detectedLang === targetLang ? null : cached;
  const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: targetLang, dt: 't', q: trimmed });
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = parseGoogleResponse(data);
    if (!result.translated || !result.detectedLang) return null;
    cacheSet(key, result);
    return result.detectedLang === targetLang ? null : result;
  } catch {
    return null; // sin red, timeout, endpoint caído/cambiado — el chat sigue sin traducción
  }
}
