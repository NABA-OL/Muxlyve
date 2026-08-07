// Desarrollado por "BlacKraken Solutions"
// Correo: nabaol.dev@gmail.com
// Fecha: 2026-08-05
//
// Shim de datos falsos para la demo pública del panel (sin backend, sin OBS, sin
// autenticación real). Se carga ANTES de flv.min.js/chat-render.js/panel-client.js
// (ver demo/build-demo.mjs) y reemplaza window.fetch + window.EventSource, así que todo
// el código real del panel corre sin cambios — nunca sabe que está en modo demo.
//
// Alcance a propósito: solo se simulan con datos vivos los endpoints que se VEN en
// pantalla (estado de destinos, chat, espectadores, perfiles). Todo lo demás (clips,
// grabaciones, selector de carpetas, export/import, notificaciones de prueba) responde
// con un valor vacío/"ok" genérico — no rompe la UI, pero tampoco simula nada rico, no
// hace falta para la demo.
(function () {
  'use strict';

  const PLATFORMS = ['Twitch', 'Kick', 'YouTube', 'TikTok'];
  const PLATFORM_URLS = {
    Twitch: 'rtmp://live.twitch.tv/app/demo',
    Kick: 'rtmps://ingest.kick.com/live/demo',
    YouTube: 'rtmp://a.rtmp.youtube.com/live2/demo',
    TikTok: 'rtmp://SERVIDOR_TIKTOK/live/demo',
  };

  const destinations = PLATFORMS.map((name, i) => ({
    name,
    url: PLATFORM_URLS[name],
    enabled: i < 2, // Twitch y Kick arrancan prendidos, como en el pantallazo de ejemplo
    note: '',
    status: i < 2 ? 'live' : 'stopped',
    attempts: 0,
    metrics: i < 2 ? { bitrate: 6000 + Math.round(Math.random() * 400), fps: 60, speed: 1 } : null,
    lagging: false,
    maxBitrate: null,
    transcoding: false,
  }));

  const presets = [{ name: 'Twitch y Kick', destinations: { Twitch: true, Kick: true, YouTube: false, TikTok: false } }];

  const CHAT_LINES = [
    { platform: 'twitch', username: 'pixel_wanderer', color: '#e91e63', message: 'hola desde el chat de prueba!' },
    { platform: 'kick', username: 'nacho_gg', color: '#53fc18', message: 'que bien se ve esto' },
    { platform: 'twitch', username: 'streamfan22', color: '#9147ff', message: 'GGs' },
    { platform: 'kick', username: 'valeria_ok', color: '#53fc18', message: 'esto es una demo, no una transmisión real jaja' },
    { platform: 'twitch', username: 'devnight', color: '#00b8d4', message: 'multistream a la vez, nice' },
  ];

  const startedAt = Date.now();
  let msgCount = 0;
  let chatStream = null;

  function buildState() {
    return {
      live: true,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      destinations,
      recorder: { active: false, duration: 60, armed: false },
      fullRecorder: { active: false, startedAt: null, armed: false },
      ingest: { width: 1920, height: 1080, fps: 60 },
    };
  }

  function viewers() {
    return {
      twitch: { live: true, count: 128 + Math.round(Math.random() * 20) },
      kick: { live: true, count: 41 + Math.round(Math.random() * 10) },
      youtube: { live: false, count: 0 },
    };
  }

  function findDest(name) { return destinations.find((d) => d.name === name); }

  const ROUTES = {
    'GET /api/state': () => buildState(),
    'GET /api/config': () => ({
      flvUrl: '', // sin esto no intenta levantar flv.js contra un servidor que no existe
      streamKey: 'demo',
      recArmed: false,
      fullRecArmed: false,
      recDuration: 60,
      clipsDir: '',
      recordingsDir: '',
      chatCommandsEnabled: true,
      discordWebhooks: [],
      telegramBots: [],
      liveMessage: '',
      endMessage: '',
      audioSilenceAlertEnabled: true,
    }),
    'GET /api/viewers': () => viewers(),
    'GET /api/presets': () => ({ presets }),
    'POST /api/presets': (body) => {
      const snapshot = Object.fromEntries(destinations.map((d) => [d.name, d.enabled]));
      const idx = presets.findIndex((p) => p.name === body.name);
      const entry = { name: body.name, destinations: snapshot };
      if (idx >= 0) presets[idx] = entry; else presets.push(entry);
      return { presets };
    },
    'POST /api/presets/apply': (body) => {
      const preset = presets.find((p) => p.name === body.name);
      if (preset) destinations.forEach((d) => { d.enabled = !!preset.destinations[d.name]; d.status = d.enabled ? 'connecting' : 'stopped'; });
      return buildState();
    },
    'DELETE /api/presets': (_, params) => {
      const name = params.get('name');
      const idx = presets.findIndex((p) => p.name === name);
      if (idx >= 0) presets.splice(idx, 1);
      return { presets };
    },
    'POST /api/destinations': (body) => {
      let d = findDest(body.name);
      if (!d) { d = { name: body.name, url: '', note: '', attempts: 0, metrics: null, lagging: false, transcoding: false }; destinations.push(d); }
      d.url = body.url ?? d.url;
      d.enabled = !!body.enabled;
      d.maxBitrate = body.maxBitrate ?? null;
      d.status = d.enabled ? 'connecting' : 'stopped';
      if (!d.enabled) d.metrics = null;
      return buildState();
    },
    'POST /api/retry': (_, params) => {
      const d = findDest(params.get('name'));
      if (d) { d.status = 'connecting'; d.attempts = 0; }
      return buildState();
    },
    'DELETE /api/destinations': (_, params) => {
      const name = params.get('name');
      const idx = destinations.findIndex((d) => d.name === name);
      if (idx >= 0) destinations.splice(idx, 1);
      return buildState();
    },
    'POST /api/chat-mode': () => ({ ok: true }),
    'POST /api/chat-send': (body) => {
      pushChatMessage({ platform: 'twitch', username: 'Tú', color: '#ffb300', message: body.text, isBroadcaster: true });
      return { twitch: { ok: true }, kick: { ok: true } };
    },
    'POST /api/chat-pin': (body) => ({ ok: true, messageId: body.messageId }),
    'POST /api/chat-unpin': () => ({ ok: true }),
    'GET /api/chat-pinned': () => ({ ok: true, messageId: null }),
    'POST /api/chat-ban': () => ({ ok: true }),
  };

  function fallback(method) {
    if (method === 'GET') return {};
    return { ok: true };
  }

  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async (input, opts = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    if (!raw.startsWith('/api/')) return realFetch ? realFetch(input, opts) : Promise.reject(new Error('sin red en la demo'));
    const [pathname, query] = raw.split('?');
    const method = (opts.method || 'GET').toUpperCase();
    const params = new URLSearchParams(query || '');
    let body = {};
    if (opts.body) { try { body = JSON.parse(opts.body); } catch { /* body no-JSON, se ignora */ } }
    const handler = ROUTES[method + ' ' + pathname];
    let data;
    try {
      data = handler ? handler(body, params) : fallback(method);
    } catch (err) {
      return { ok: false, status: 400, json: async () => ({ error: err.message }) };
    }
    return { ok: true, status: 200, json: async () => data };
  };

  // EventSource: el panel usa /api/chat (mensajes en vivo), /api/audio y /api/debug-log
  // (ambos irrelevantes para la demo). Una sola clase falsa para las tres — solo /api/chat
  // recibe eventos empujados por el ticker de abajo, las otras dos quedan mudas para
  // siempre, que es exactamente lo que un usuario sin esas señales vería igual.
  class DemoEventSource {
    constructor(url) {
      this.url = url;
      this.onmessage = null;
      this.onerror = null;
      if (url.startsWith('/api/chat')) chatStream = this;
    }
    addEventListener() {}
    close() { if (chatStream === this) chatStream = null; }
  }
  window.EventSource = DemoEventSource;

  function pushChatMessage(partial) {
    if (!chatStream || !chatStream.onmessage) return;
    msgCount++;
    const msg = { id: 'demo-' + msgCount, userId: 'demo-user-' + msgCount, ...partial };
    chatStream.onmessage({ data: JSON.stringify(msg) });
  }

  // Ticker: cada ~4s manda un mensaje de chat de muestra; cada ~2.5s hace temblar un poco
  // el bitrate de los destinos activos, para que las tarjetas se vean "vivas" igual que en
  // la app real (ver metricsFor() en panel-client.js).
  let chatIdx = 0;
  setInterval(() => {
    const line = CHAT_LINES[chatIdx % CHAT_LINES.length];
    chatIdx++;
    pushChatMessage(line);
  }, 4000);

  setInterval(() => {
    destinations.forEach((d) => {
      if (d.status !== 'live' || !d.metrics) return;
      d.metrics.bitrate = Math.max(4500, Math.min(6800, d.metrics.bitrate + Math.round((Math.random() - 0.5) * 300)));
    });
    // Los destinos recién prendidos pasan de "connecting" a "live" al segundo tick, igual
    // que el relay real tarda un momento en confirmar conexión.
    destinations.forEach((d) => {
      if (d.status === 'connecting') { d.status = 'live'; d.metrics = { bitrate: 5800, fps: 60, speed: 1 }; }
    });
  }, 2500);
})();
