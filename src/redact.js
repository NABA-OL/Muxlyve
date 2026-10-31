/*
 * Propiedad de BlacKraken Solutions <blackraken.com>
 * Desarrollado por: NABAOL
 * Fecha de creación: 2026-10-10
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
// Las claves de transmisión viajan en el path (y a veces en el query, ej. srt streamid /
// passphrase) de la URL del destino, y FFmpeg imprime la URL completa en sus errores
// ("rtmp://host/app/CLAVE: Connection refused"). Todo lo que llega a console.* termina en
// el buffer de "Reportar un problema" (electron/logbuffer.js), así que se enmascara acá:
// se conserva esquema + host:puerto (útil para diagnosticar) y se oculta el resto.
const STREAM_URL_RE = /\b((?:rtmps?|srt):\/\/[^\s/?#'"]+)[^\s'"]*/gi;

export function redactStreamUrls(text) {
  return String(text).replace(STREAM_URL_RE, '$1/****');
}
