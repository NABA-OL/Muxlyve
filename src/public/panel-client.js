  // Barra de título fundida con la UI — el padding exacto depende de qué lado ocupan
  // los botones nativos (izquierda en Mac, derecha en Windows). Se aplica ya mismo,
  // antes de cualquier otra cosa, para que no haya parpadeo del layout sin compensar.
  (function () {
    const ua = navigator.userAgent;
    if (ua.includes('Mac')) document.body.classList.add('platform-darwin');
    else if (ua.includes('Windows')) document.body.classList.add('platform-win32');
    else if (ua.includes('Linux')) document.body.classList.add('platform-linux');
  })();

  window.onerror = (msg, src, line, col, err) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#f85149;color:#fff;padding:8px 12px;font:13px monospace;white-space:pre-wrap';
    d.textContent = '[ERROR] ' + msg + ' (' + (src || '') + ':' + line + ':' + col + ')';
    document.body?.appendChild(d);
  };
  window.onunhandledrejection = (e) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:40px;left:0;right:0;z-index:9999;background:#d29922;color:#fff;padding:8px 12px;font:13px monospace;white-space:pre-wrap';
    d.textContent = '[PROMISE] ' + (e.reason?.message || e.reason || 'rejected');
    document.body?.appendChild(d);
  };
  const $ = (s) => document.querySelector(s);
  const PLATFORM_IDS = ['twitch', 'youtube', 'kick', 'tiktok'];
  const AUTH_PLATFORMS = [
    { id: 'twitch',  name: 'Twitch',  color: '#9147ff' },
    { id: 'youtube', name: 'YouTube', color: '#ff0000' },
    { id: 'kick',    name: 'Kick',    color: '#53fc18' },
    { id: 'tiktok',  name: 'TikTok',  color: '#fe2c55', soon: true },
  ];
  // Google todavía no aprobó la verificación OAuth — bloquea el login de YouTube SOLO en
  // producción empaquetada (en dev sigue funcionando para poder seguir probando/iterando
  // con Google). Cuando llegue la aprobación, cambiar esto a false y listo.
  const YOUTUBE_OAUTH_PENDING = true;
  let lastState = null;
  let lastAuthStatus = {};
  // Idioma actual del cliente — el <html lang="es"> del template ya llega traducido por
  // translateHtml() (mismo tMap del servidor), así que es una señal confiable sin duplicar
  // el mecanismo de i18n para texto armado en runtime (fmtClipAge, botones del updater).
  const UI_LANG = document.documentElement.lang || 'es';
  function pick(dict) { return dict[UI_LANG] || dict.es; }
  // Filtro de palabras del chat — declarado acá arriba porque loadChatKeywords() se llama
  // desde el bloque de "restaura preferencias" más abajo en el archivo; si esta variable
  // se declarara más abajo que esa llamada, revienta con TDZ (cannot access before
  // initialization) al cargar la página.
  let chatKeywords = [];
  // Gráfico de salud de red por destino — solo en memoria del cliente (sin backend/DB):
  // ventana corta de bitrate reciente, se borra en cuanto el destino deja de estar 'live'
  // para no mezclar sesiones de transmisión distintas en la misma línea.
  const metricsHistory = {};
  const METRICS_HISTORY_MAX = 30; // ~1 min a ~2s por poll

  // ── Resumen post-stream — acumuladores de sesión, todo en memoria del cliente ──
  // (mismo criterio que metricsHistory: sin backend/DB nuevos). Se resetean al
  // arrancar una sesión en vivo, se leen al terminarla (ver render()).
  let sessionPeakViewers = { twitch: 0, kick: 0, youtube: 0 };
  let sessionChatMsgCount = 0;
  let sessionLastUptime = 0;
  let sessionBitrateSum = {};
  let sessionBitrateCount = {};
  function resetSessionStats() {
    sessionPeakViewers = { twitch: 0, kick: 0, youtube: 0 };
    sessionChatMsgCount = 0;
    sessionBitrateSum = {};
    sessionBitrateCount = {};
  }

  function trackMetricsHistory(state) {
    for (const d of state.destinations) {
      if (d.status === 'live' && d.metrics && typeof d.metrics.bitrate === 'number') {
        const hist = metricsHistory[d.name] || (metricsHistory[d.name] = []);
        hist.push(d.metrics.bitrate);
        if (hist.length > METRICS_HISTORY_MAX) hist.shift();
        sessionBitrateSum[d.name] = (sessionBitrateSum[d.name] || 0) + d.metrics.bitrate;
        sessionBitrateCount[d.name] = (sessionBitrateCount[d.name] || 0) + 1;
      } else {
        delete metricsHistory[d.name];
      }
    }
  }
  function sparkColor(pillCls) {
    if (pillCls === 'live') return 'var(--live)';
    if (pillCls === 'lagging' || pillCls === 'reconnecting') return 'var(--warn)';
    if (pillCls === 'failed') return 'var(--danger)';
    return 'var(--muted)';
  }
  function sparklineSvg(history, color) {
    if (!history || history.length < 2) return '';
    const w = 64, h = 20;
    const min = Math.min(...history), max = Math.max(...history);
    const range = (max - min) || 1;
    const pts = history.map((v, i) => {
      const x = (i / (history.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const last = history[history.length - 1];
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
      '" preserveAspectRatio="none"><title>' + last + ' kbps</title>' +
      '<polyline points="' + pts + '" fill="none" stroke="' + color +
      '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  // El refresh automático (cada 2s) reconstruye los bloques de plataforma desde cero —
  // sin esto, borraría el formulario "+ Añadir servidor RTMP" abierto y lo que llevas escrito.
  const pbAddOpen = {};
  const pbAddDraft = {};
  let msgTimer;
  let flvUrl = '';
  let player = null;

  function toast(text, isErr) {
    const m = $('#msg');
    m.textContent = text;
    m.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => (m.className = ''), 2500);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    return data;
  }

  function fmtUptime(s) {
    if (s == null) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return (h ? p(h) + ':' : '') + p(m) + ':' + p(sec);
  }

  // Ícono de ojo (SVG, no emoji) para togglear campos ocultos. abierto=mostrar, cerrado=ocultar.
  function eyeSvg(open) {
    return open
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  }

  // PLATFORM_ICON_GLYPHS/COLORS, platformIconSvg, BROADCASTER_BADGE_SVG, PIN_ICON_SVG,
  // renderMessageBody, y la lógica de fijar/desfijar (updatePinBtnState/pinChatMessageUi/
  // syncPinnedMessage) viven en /chat-render.js — compartido con el popout de chat y el
  // overlay de OBS, ver src/public/chat-render.js. Se carga antes que este script.

  // Empareja el nombre de un destino personalizado con una plataforma conocida (substring, sin distinguir mayúsculas).
  function matchPlatformId(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('twitch')) return 'twitch';
    if (n.includes('youtube') || /(^|[^a-z])yt([^a-z]|$)/.test(n)) return 'youtube';
    if (n.includes('kick')) return 'kick';
    if (n.includes('tiktok')) return 'tiktok';
    return null;
  }

  // Devuelve { cls, text } para la píldora de estado de un destino.
  function pillFor(d) {
    if (d.status === 'live') {
      return d.lagging
        ? { cls: 'lagging', text: '⚠ rezagado' }
        : { cls: 'live', text: '● reenviando' };
    }
    if (d.status === 'connecting') return { cls: 'reconnecting', text: '⟳ conectando…' };
    if (d.status === 'reconnecting') return { cls: 'reconnecting', text: '⟳ reconectando… intento ' + d.attempts };
    if (d.status === 'failed') return { cls: 'failed', text: '✕ falló' };
    return { cls: d.enabled ? 'on' : 'off', text: d.enabled ? 'activo' : 'apagado' };
  }

  function metricsFor(d) {
    if (d.status !== 'live' || !d.metrics) return '';
    const parts = [];
    if (d.metrics.bitrate != null) parts.push(d.metrics.bitrate + ' kbps');
    // d.metrics.fps es el contador interno de FFmpeg (cuadros procesados por segundo de
    // reloj real, no fps del video — con -c copy y speed > 1x sale inflado, ej. 234 "fps"
    // a 60fps real x3.87 de velocidad). Se divide por speed para mostrar el fps real de la
    // señal, que es lo que el usuario espera ver acá.
    if (d.metrics.fps != null) {
      const realFps = d.metrics.speed ? d.metrics.fps / d.metrics.speed : d.metrics.fps;
      parts.push(Math.round(realFps) + ' fps');
    }
    if (d.metrics.speed != null) parts.push(d.metrics.speed + 'x');
    return parts.join(' · ');
  }

  function fmtDur(s) {
    if (s < 60) return s + 's';
    const min = s / 60;
    return (Number.isInteger(min) ? min : min.toFixed(1)) + ' min';
  }

  // El toggle nunca se deshabilita, aunque no haya señal todavía — activarlo sin señal
  // solo "arma" la intención (localStorage, ver toggleRec/autoResumeRecorders); en cuanto
  // llegue la señal, arranca solo. Así no hace falta acordarse de prenderlo justo cuando
  // conectas el software de streaming.
  function updateRecorder(state) {
    const rec = state.recorder || { active: false, duration: 60 };
    const toggle = $('#recToggle');
    const saveBtn = $('#clipSaveBtn');
    const status = $('#recStatus');
    toggle.disabled = false;
    if (rec.active) {
      toggle.checked = true;
      saveBtn.style.display = '';
      status.className = 'rec-status on';
      status.textContent = '● Grabando — último ' + fmtDur(rec.duration) + ' disponible';
    } else if (!state.live) {
      toggle.checked = !!rec.armed;
      saveBtn.style.display = 'none';
      status.className = rec.armed ? 'rec-status on' : 'rec-status';
      status.textContent = rec.armed
        ? 'Listo — arranca solo apenas conectes tu software de streaming.'
        : 'Conecta tu software de streaming para usar el buffer.';
    } else {
      toggle.checked = false;
      saveBtn.style.display = 'none';
      status.className = 'rec-status';
      status.textContent = 'Buffer inactivo.';
    }
  }

  function updateFullRecorder(state) {
    const rec = state.fullRecorder || { active: false, startedAt: null };
    const toggle = $('#fullRecToggle');
    const status = $('#fullRecStatus');
    toggle.disabled = false;
    if (rec.active) {
      toggle.checked = true;
      status.className = 'rec-status on';
      const secs = rec.startedAt ? Math.floor((Date.now() - rec.startedAt) / 1000) : 0;
      status.textContent = '● Grabando — ' + fmtDur(secs);
    } else if (!state.live) {
      toggle.checked = !!rec.armed;
      status.className = rec.armed ? 'rec-status on' : 'rec-status';
      status.textContent = rec.armed
        ? 'Listo — arranca sola apenas conectes tu software de streaming.'
        : 'Conecta tu software de streaming para grabar.';
    } else {
      toggle.checked = false;
      status.className = 'rec-status';
      status.textContent = 'Grabación completa inactiva.';
    }
  }

  // ── Ingest: stats de video + VU meter de audio ──
  // SSE setea los objetivos; un loop de suavizado (ataque rápido / caída lenta) anima las barras.
  const vu = { tL: 0, tR: 0, dL: 0, dR: 0, live: false };
  function applyVu(el, v) {
    el.style.width = v + '%';
  }
  (function vuLoop() {
    const ease = (d, t) => d + (t - d) * (t > d ? 0.7 : 0.12); // sube rápido, baja suave
    vu.dL = ease(vu.dL, vu.live ? vu.tL : 0);
    vu.dR = ease(vu.dR, vu.live ? vu.tR : 0);
    applyVu($('#vuL'), Math.round(vu.dL));
    applyVu($('#vuR'), Math.round(vu.dR));
    requestAnimationFrame(vuLoop);
  })();

  (function initAudioSSE() {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/audio');
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'silence') {
          window.msApp?.notify?.('Muxlyve', 'No se detecta audio en la señal hace 20 segundos — revisa tu micrófono o la app de captura.');
          return;
        }
        vu.tL = msg.l; vu.tR = msg.r;
      } catch {}
    };
    // EventSource reconecta solo ante error; nada más que hacer.
  })();

  // Vuelca src/panel.js:debugLog() acá — es la única consola que el usuario puede abrir
  // en la app empaquetada (DevTools de esta ventana). Ver LAN pairing con Stream Deck.
  (function initDebugLogSSE() {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/debug-log');
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data);
        (entry.level === 'error' ? console.error : console.log)('[panel-debug]', entry.line);
      } catch {}
    };
  })();

  function updateIngest(state) {
    vu.live = !!state.live;
    const bar = $('#ingestBar');
    if (!state.live || !state.ingest) {
      bar.style.display = 'none';
      vu.tL = vu.tR = 0;
      return;
    }
    bar.style.display = '';
    const ing = state.ingest;
    const parts = [];
    if (ing.width && ing.height) parts.push(ing.width + '×' + ing.height);
    if (ing.fps != null) parts.push(ing.fps + ' fps');
    $('#ingestVideo').textContent = 'Entrada: ' + (parts.join(' · ') || '—');
  }

  // Alerta fuera del panel cuando un destino se cae — solo dispara en la TRANSICIÓN a
  // 'failed' (no en cada poll de 2s mientras se queda ahí), para no repetir la misma
  // notificación 30 veces. Silenciosa si no hay msApp.notify (navegador sin Electron).
  const lastDestStatus = {};
  function notifyDestinationFailures(state) {
    for (const d of state.destinations) {
      const prev = lastDestStatus[d.name];
      if (d.status === 'failed' && prev !== 'failed') {
        window.msApp?.notify?.('Muxlyve', d.name + ': se cayó la conexión.');
      }
      lastDestStatus[d.name] = d.status;
    }
  }

  function render(state) {
    const wasLive = lastState?.live;
    lastState = state;
    trackMetricsHistory(state);
    notifyDestinationFailures(state);
    if (state.live) sessionLastUptime = state.uptime;
    if (!wasLive && state.live) {
      resetSessionStats();
    }
    if (wasLive && !state.live) showSessionSummary();
    $('#liveDot').className = 'dot' + (state.live ? ' on' : '');
    $('#liveTxt').textContent = state.live ? 'En vivo' : 'esperando señal';
    $('#uptime').textContent = state.live ? fmtUptime(state.uptime) : '';
    $('#videoWrap').classList.toggle('live', state.live);
    updatePreview(state.live);
    updateRecorder(state);
    updateFullRecorder(state);
    updateIngest(state);
    renderPlatforms();
    renderCustom(state);
  }

  function renderPlatforms() {
    if (!lastState) return;
    const state = lastState;
    const authSt = lastAuthStatus;
    const pl = $('#platformList');
    pl.innerHTML = '';
    for (const p of AUTH_PLATFORMS) {
      const rtmpDest = state.destinations.find(d => d.name.toLowerCase() === p.id) || null;
      const authS = authSt[p.id] || {};
      const storedOpen = localStorage.getItem('ms_pb_' + p.id);
      const isOpen = storedOpen === '1';
      const block = document.createElement('div');
      const stateClass = (rtmpDest && rtmpDest.url) ? (rtmpDest.enabled ? ' pb-on' : ' pb-off') : '';
      block.className = 'pb-block' + (isOpen ? ' open' : '') + stateClass;
      block.id = 'pb-' + p.id;
      // renderPlatforms() reconstruye este nodo desde cero en cada refresh (cada 2s) — sin
      // esto, el glow pulsante (@keyframes pbGlowOn/Off, ciclo de 5s) se reiniciaba a los
      // 2s de cada vez, nunca llegaba a completar una vuelta suave y se veía "saltar" de
      // naranja a rojo de golpe. Un animation-delay NEGATIVO sincroniza la fase al reloj
      // real: el elemento nuevo arranca ya avanzado el tramo del ciclo que le toca, como si
      // nunca se hubiera reiniciado — mismo efecto visual continuo que .video-wrap, que sí
      // reutiliza el mismo nodo (classList.toggle) en vez de recrearlo.
      if (stateClass) block.style.animationDelay = '-' + ((Date.now() % 5000) / 1000) + 's';

      // OAuth header part
      let oauthHtml = '';
      if (p.soon) {
        oauthHtml = '<span class="pb-soon-tag">OAuth próx.</span>';
      } else if (authS.connected) {
        const user = authS.username || 'conectado';
        oauthHtml = '<span class="pb-user" title="' + user + '">' + user + '</span>' +
          '<button class="auth-disc" data-id="' + p.id + '" onclick="disconnectPlatform(this.dataset.id)">&#10005;</button>';
      } else {
        oauthHtml = '<button class="auth-conn" data-id="' + p.id + '" onclick="connectPlatform(this.dataset.id)">Conectar</button>';
      }

      // Sparkline en la cabecera — visible con la tarjeta colapsada o no (entre el
      // nombre y "Conectar"). La píldora ("rezagado"/"reenviando") y las métricas en
      // texto se quedan adentro del cuerpo (pb-rtmp), solo visibles al expandir.
      let headSparkHtml = '';
      if (rtmpDest) {
        const headPill = pillFor(rtmpDest);
        headSparkHtml = sparklineSvg(metricsHistory[rtmpDest.name], sparkColor(headPill.cls));
        // Sin datos de transmisión todavía (no hay sparkline) — si este destino tiene
        // una hora programada pendiente, mostrarla ahí mismo en vez de dejarlo vacío.
        if (!headSparkHtml && scheduledEntries[rtmpDest.name]) {
          headSparkHtml = '<span class="sched-time-badge" title="Programado para activarse solo">&#8987; ' + fmtScheduledTime(scheduledEntries[rtmpDest.name].atMs) + '</span>';
        }
      }

      // RTMP body
      let bodyHtml = '';
      if (rtmpDest) {
        const d = rtmpDest;
        const isTikTok = p.id === 'tiktok';
        const pill = pillFor(d);
        const metrics = metricsFor(d);
        bodyHtml += '<div class="pb-rtmp">';
        bodyHtml += '<div class="card-head"><span class="pill ' + pill.cls + '">' + pill.text + '</span>';
        if (d.transcoding) bodyHtml += '<span class="pill" style="color:var(--warn);background:rgba(240,162,58,.15)" title="Bitrate máximo activo — este destino se está recodificando">&#9889; recodificando</span>';
        if (metrics) bodyHtml += '<span class="metrics">' + metrics + '</span>';
        bodyHtml += '</div>';
        bodyHtml += '<div class="field"><label>URL RTMP' + (isTikTok ? ' &#8212; clave temporal' : '') + '</label>';
        bodyHtml += '<div class="eyerow"><input type="password" class="pb-url" value="" autocomplete="off">';
        bodyHtml += '<button type="button" class="eye-btn" onclick="toggleFieldEye(this)" title="Mostrar/ocultar">' + eyeSvg(false) + '</button></div></div>';
        bodyHtml += '<details class="bitrate-collapse">';
        bodyHtml += '<summary>Bitrate máximo (kbps) — opcional</summary>';
        bodyHtml += '<input type="number" class="pb-maxbitrate" min="500" step="500" placeholder="Vacio = Mismo Bitrate origen" value="' + (d.maxBitrate || '') + '"></details>';
        bodyHtml += '<div class="row"><label class="switch">';
        bodyHtml += '<input type="checkbox" class="pb-toggle-cb" data-name="' + d.name + '"' + (d.enabled ? ' checked' : '') + ' onchange="togglePbRtmp(this)">';
        bodyHtml += '<span class="thumb"></span></label>';
        bodyHtml += '<button class="save" data-name="' + d.name + '" onclick="savePbRtmp(this)">Guardar</button>';
        if (d.status === 'failed') bodyHtml += '<button class="retry" data-name="' + d.name + '" onclick="retryPbRtmp(this)">Reintentar</button>';
        bodyHtml += '<button class="del" data-name="' + d.name + '" onclick="delPbRtmp(this)">Borrar</button></div>';
        if (d.enabled && !state.live) bodyHtml += '<p class="auto-note">* Arrancará cuando empiece la transmisión.</p>';
        if (isTikTok) bodyHtml += '<p class="auto-note">&#9651; TikTok regenera la clave cada sesión (~2h).</p>';
        bodyHtml += '</div>';
      } else {
        const isTikTok = p.id === 'tiktok';
        if (p.id === 'youtube' && authS.connected) {
          bodyHtml += '<p class="auto-note">&#8505; Conectado como ' + (authS.username || 'tu cuenta') +
            ' — no se pudo traer tu clave automáticamente (¿configuraste "Ir en vivo" en ' +
            'YouTube Studio al menos una vez?). Cópiala desde ahí y pégala abajo.</p>';
        }
        if (isTikTok) {
          bodyHtml += '<p class="auto-note">&#8505; TikTok no tiene login — consigue tu URL y clave así: ' +
            'abre la app de TikTok &#8594; toca + &#8594; LIVE &#8594; icono de ajustes antes de salir ' +
            'en vivo &#8594; "Transmitir desde PC/consola". Copia el Server URL y la Stream Key que te ' +
            'muestre y pégalos abajo. Esa clave expira en unas horas — genérala justo antes de transmitir.</p>';
        }
        const openStyle = pbAddOpen[p.id] ? ' style="display:none"' : '';
        const formStyle = pbAddOpen[p.id] ? '' : ' style="display:none"';
        bodyHtml += '<button class="pb-add-rtmp-btn" data-pid="' + p.id + '" onclick="showAddPlatformRtmp(this.dataset.pid)"' + openStyle + '>+ Añadir servidor RTMP</button>';
        bodyHtml += '<div class="pb-add-rtmp-form" id="pb-add-form-' + p.id + '"' + formStyle + '>';
        bodyHtml += '<div class="field"><label>URL RTMP' + (isTikTok ? ' &#8212; clave temporal TikTok' : '') + '</label>';
        bodyHtml += '<input type="text" id="pb-new-url-' + p.id + '" placeholder="rtmp://servidor/app/CLAVE" oninput="onPbDraftInput(this)"></div>';
        bodyHtml += '<div class="row" style="margin-top:.5rem">';
        bodyHtml += '<button class="save" data-pid="' + p.id + '" onclick="addPlatformRtmp(this.dataset.pid)">Añadir</button>';
        bodyHtml += '<button class="del" data-pid="' + p.id + '" onclick="cancelAddPlatformRtmp(this.dataset.pid)">Cancelar</button>';
        bodyHtml += '</div></div>';
      }

      block.innerHTML =
        '<div class="pb-head" data-pid="' + p.id + '" onclick="togglePlatformBlock(this.dataset.pid)">' +
        '<i class="pb-chevron">&#9654;</i>' +
        (platformIconSvg(p.id) || '<span class="p-dot" style="background:' + p.color + '"></span>') +
        '<span class="pb-head-name">' + p.name + '</span>' +
        headSparkHtml +
        oauthHtml +
        '</div>' +
        '<div class="pb-body"><div class="pb-body-inner">' + bodyHtml + '</div></div>';

      if (rtmpDest) block.querySelector('.pb-url').value = rtmpDest.url;
      if (pbAddDraft[p.id]) {
        const draftInput = block.querySelector('#pb-new-url-' + p.id);
        if (draftInput) draftInput.value = pbAddDraft[p.id];
      }
      pl.appendChild(block);
    }
  }

  // El input de "+ Añadir servidor RTMP" solo existe cuando rtmpDest es null (else branch),
  // así que su id siempre trae el pid — se guarda para sobrevivir el refresh cada 2s.
  function onPbDraftInput(input) {
    const pid = input.id.replace('pb-new-url-', '');
    pbAddDraft[pid] = input.value;
  }

  function renderCustom(state) {
    const cl = $('#customList');
    const custom = state.destinations.filter(d => !PLATFORM_IDS.includes(d.name.toLowerCase()));
    cl.innerHTML = '';
    if (custom.length === 0) return;
    cl.appendChild(Object.assign(document.createElement('div'), { className: 'custom-sep' }));
    for (const d of custom) {
      const isTikTok = /tiktok/i.test(d.name);
      const pill = pillFor(d);
      const metrics = metricsFor(d);
      const matchedId = matchPlatformId(d.name);
      const icon = matchedId ? platformIconSvg(matchedId, 16) : '';
      const card = document.createElement('div');
      card.className = 'card' + (isTikTok ? ' tiktok' : '');
      card.innerHTML = `
        <div class="card-head">
          ${icon}
          <span class="name"></span>
          <span class="pill ${pill.cls}"></span>
          ${d.transcoding ? '<span class="pill" style="color:var(--warn);background:rgba(240,162,58,.15)" title="Bitrate máximo activo — este destino se está recodificando">&#9889; recodificando</span>' : ''}
          <span class="metrics"></span>
          <span class="spark-slot"></span>
        </div>
        <div class="field">
          <label>URL RTMP${isTikTok ? ' &#8212; clave temporal TikTok' : ''}</label>
          <div class="eyerow">
            <input type="password" class="url" value="" autocomplete="off">
            <button type="button" class="eye-btn" onclick="toggleFieldEye(this)" title="Mostrar/ocultar">${eyeSvg(false)}</button>
          </div>
        </div>
        <details class="bitrate-collapse">
          <summary>Bitrate máximo (kbps) — opcional</summary>
          <input type="number" class="max-bitrate" min="500" step="500" placeholder="Vacio = Mismo Bitrate origen">
        </details>
        <div class="row">
          <label class="switch" title="${d.enabled ? 'Desactivar' : 'Activar'}">
            <input type="checkbox" class="toggle-cb"${d.enabled ? ' checked' : ''}>
            <span class="thumb"></span>
          </label>
          <button class="save">Guardar</button>
          ${d.status === 'failed' ? '<button class="retry">Reintentar</button>' : ''}
          <button class="del">Borrar</button>
        </div>
        ${d.enabled && !state.live ? '<p class="auto-note">* Arrancará cuando empiece la transmisión.</p>' : ''}
        ${d.note ? '<p class="note"></p>' : ''}
      `;
      card.querySelector('.name').textContent = d.name;
      card.querySelector('.pill').textContent = pill.text;
      card.querySelector('.metrics').textContent = metrics;
      card.querySelector('.spark-slot').innerHTML = sparklineSvg(metricsHistory[d.name], sparkColor(pill.cls));
      const urlInput = card.querySelector('.url');
      urlInput.value = d.url;
      const bitrateInput = card.querySelector('.max-bitrate');
      bitrateInput.value = d.maxBitrate || '';
      if (d.note) card.querySelector('.note').textContent = '&#9651; ' + d.note;
      card.querySelector('.toggle-cb').onchange = (e) => save(d.name, urlInput.value, e.target.checked, bitrateInput.value);
      card.querySelector('.save').onclick = () => save(d.name, urlInput.value, d.enabled, bitrateInput.value);
      card.querySelector('.del').onclick = () => del(d.name);
      const retryBtn = card.querySelector('.retry');
      if (retryBtn) retryBtn.onclick = () => doRetry(d.name);
      cl.appendChild(card);
    }
  }

  function togglePlatformBlock(pid) {
    const block = $('#pb-' + pid);
    if (!block) return;
    const isOpen = block.classList.toggle('open');
    localStorage.setItem('ms_pb_' + pid, isOpen ? '1' : '0');
  }

  function showAddPlatformRtmp(pid) {
    pbAddOpen[pid] = true;
    const form = $('#pb-add-form-' + pid);
    if (!form) return;
    form.previousElementSibling.style.display = 'none';
    form.style.display = '';
  }

  function cancelAddPlatformRtmp(pid) {
    pbAddOpen[pid] = false;
    delete pbAddDraft[pid];
    const form = $('#pb-add-form-' + pid);
    if (!form) return;
    form.style.display = 'none';
    form.previousElementSibling.style.display = '';
    const inp = $('#pb-new-url-' + pid);
    if (inp) inp.value = '';
  }

  // Evita que el poll de refresh() (cada 2s) pise una mutación en curso o
  // los campos que el usuario está llenando — root cause de que el formulario
  // "añadir servidor" se borrara solo, clics se perdieran, o un borrado se
  // revirtiera por una respuesta de refresh() llegando después.
  let destBusy = false;
  async function withDestBusy(fn) {
    destBusy = true;
    try { await fn(); } finally { destBusy = false; }
  }

  async function addPlatformRtmp(pid) {
    const inp = $('#pb-new-url-' + pid);
    const url = inp ? inp.value.trim() : '';
    if (!url) { toast('Pon una URL', true); return; }
    const name = (AUTH_PLATFORMS.find(p => p.id === pid) || {}).name || pid;
    try {
      await withDestBusy(async () => {
        pbAddOpen[pid] = false;
        delete pbAddDraft[pid];
        render(await api('POST', '/api/destinations', { name, url, enabled: false }));
      });
      toast(name + ' RTMP añadido');
    } catch (e) { toast(e.message, true); }
  }

  function savePbRtmp(btn) {
    const name = btn.dataset.name;
    const card = btn.closest('.pb-rtmp');
    save(name, card.querySelector('.pb-url').value, card.querySelector('.pb-toggle-cb').checked, card.querySelector('.pb-maxbitrate').value);
  }

  function delPbRtmp(btn) { del(btn.dataset.name); }
  function retryPbRtmp(btn) { doRetry(btn.dataset.name); }

  function togglePbRtmp(cb) {
    const card = cb.closest('.pb-rtmp');
    save(cb.dataset.name, card.querySelector('.pb-url').value, cb.checked, card.querySelector('.pb-maxbitrate').value);
  }

  async function doRetry(name) {
    try {
      await withDestBusy(async () => { render(await api('POST', '/api/retry?name=' + encodeURIComponent(name))); });
      toast('Reintentando ' + name);
    } catch (e) { toast(e.message, true); }
  }

  async function save(name, url, enabled, maxBitrate) {
    try {
      await withDestBusy(async () => { render(await api('POST', '/api/destinations', { name, url, enabled, maxBitrate })); });
      toast(enabled ? name + ' activado' : name + ' guardado');
    } catch (e) { toast(e.message, true); refresh(); }
  }
  async function del(name) {
    if (!confirm('¿Borrar ' + name + '?')) return;
    try {
      await withDestBusy(async () => { render(await api('DELETE', '/api/destinations?name=' + encodeURIComponent(name))); });
      toast(name + ' borrado');
    } catch (e) { toast(e.message, true); }
  }
  async function addDest() {
    const name = $('#newName').value.trim();
    const url = $('#newUrl').value.trim();
    if (!name) return toast('Pon un nombre', true);
    try {
      await withDestBusy(async () => { render(await api('POST', '/api/destinations', { name, url, enabled: false })); });
      $('#newName').value = ''; $('#newUrl').value = ''; toast(name + ' añadido');
    } catch (e) { toast(e.message, true); }
  }

  // Perfiles de destinos — ver src/presets.js. Los chips arrancan cargados en loadPresets()
  // (llamado al inicio junto con loadConfig/refresh) y se refrescan tras cada cambio.
  async function loadPresets() {
    try { renderPresets((await api('GET', '/api/presets')).presets || []); } catch {}
  }
  function renderPresets(presets) {
    window._presets = presets; // applyPresetUi() necesita leer title/category por nombre
    const chips = $('#presetChips');
    chips.innerHTML = '';
    if (!presets.length) {
      const empty = document.createElement('span');
      empty.className = 'preset-chips-empty';
      empty.textContent = 'Sin perfiles guardados — activa los destinos que quieras y toca "Guardar actual".';
      chips.appendChild(empty);
      return;
    }
    for (const p of presets) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'preset-chip' + (p.active ? ' active' : '');
      const hasStreamInfo = !!(p.title || p.category);
      chip.title = (p.active ? 'Activo ahora' : 'Aplicar este perfil') + (hasStreamInfo ? ' (incluye título/categoría)' : '');
      chip.onclick = () => applyPresetUi(p.name);
      const label = document.createElement('span');
      label.textContent = p.name;
      chip.appendChild(label);
      const del = document.createElement('span');
      del.className = 'preset-del';
      del.textContent = '✕';
      del.title = 'Borrar perfil';
      del.onclick = (e) => { e.stopPropagation(); deletePresetUi(p.name); };
      chip.appendChild(del);
      chips.appendChild(chip);
    }
  }
  async function applyPresetUi(name) {
    try {
      const preset = (window._presets || []).find((p) => p.name === name);
      await withDestBusy(async () => { render(await api('POST', '/api/presets/apply', { name })); });
      toast('Perfil "' + name + '" aplicado');
      if (preset) await applyPresetStreamInfo(preset); // no-op si el perfil no guardó título/categoría
    } catch (e) { toast(e.message, true); }
  }
  // Perfiles guardados con título/categoría (ver saveCurrentPreset) también los aplican
  // al aplicarse — mismo camino que el botón "Aplicar" de "Modificar información del
  // stream" (applyStreamTitle), pero sin abrir ese modal ni depender de sus inputs. Nunca
  // debe poder tumbar el apply de destinos si algo sale mal acá — por eso vive en un
  // try/catch propio, llamado DESPUÉS de que los destinos ya se aplicaron.
  async function applyPresetStreamInfo(preset) {
    if (!preset.title && !preset.category) return;
    if (!window.msOAuth?.setTitle) return; // panel abierto en un navegador sin Electron — no rompe nada
    try {
      const results = await window.msOAuth.setTitle(preset.title || '', preset.category || '');
      if (!Object.keys(results || {}).length) return; // sin Twitch/Kick conectado, nada que actualizar
      if (preset.title) localStorage.setItem('ms_stream_title', preset.title);
      if (preset.category) localStorage.setItem('ms_stream_category', preset.category);
      updateStreamTitleDisplay();
    } catch {}
  }
  // Captura el título/categoría actual (lo último aplicado con éxito, ver
  // applyStreamTitle) junto con los destinos — así aplicar el perfil después restaura las
  // tres cosas juntas. Si el streamer nunca seteó un título, el perfil se guarda igual,
  // solo que sin esos dos campos (perfil "de siempre", sin sorpresas).
  async function saveCurrentPreset() {
    const name = await showPrompt('Guardar perfil actual', 'Ej. Solo Twitch');
    if (!name) return;
    try {
      const title = localStorage.getItem('ms_stream_title') || '';
      const category = localStorage.getItem('ms_stream_category') || '';
      const { presets } = await api('POST', '/api/presets', { name, title, category });
      renderPresets(presets);
      toast('Perfil "' + name + '" guardado');
    } catch (e) { toast(e.message, true); }
  }
  async function deletePresetUi(name) {
    const ok = await showConfirm('¿Borrar el perfil "' + name + '"?', 'Borrar');
    if (!ok) return;
    try {
      const { presets } = await api('DELETE', '/api/presets?name=' + encodeURIComponent(name));
      renderPresets(presets);
    } catch (e) { toast(e.message, true); }
  }
  async function applyStreamTitle(btn) {
    const title = $('#titleInput').value.trim();
    const category = $('#categoryInput').value.trim();
    if (!title && !category) return toast('Escribe un título o una categoría primero', true);
    if (!window.msOAuth?.setTitle) return toast('No disponible en esta versión.', true);
    if (btn) btn.disabled = true;
    try {
      const results = await window.msOAuth.setTitle(title, category);
      const entries = Object.entries(results || {});
      if (!entries.length) { toast('Conecta Twitch o Kick primero.', true); return; }
      const failed = entries.filter(([, r]) => !r.ok);
      if (!failed.length) {
        if (title) localStorage.setItem('ms_stream_title', title);
        if (category) localStorage.setItem('ms_stream_category', category);
        updateStreamTitleDisplay();
        closeStreamInfo();
        toast('Actualizado en ' + entries.map(([p]) => p).join(' + '));
      } else {
        const [, firstErr] = failed[0];
        toast((firstErr.error || ('Falló en ' + failed.map(([p]) => p).join(', '))), true);
      }
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function toggleChatMenu(e) {
    e.stopPropagation();
    $('#chatMenuDd').classList.toggle('open');
  }
  function toggleOverlayInfo(e) {
    e.stopPropagation();
    $('#overlayInfoDd').classList.toggle('open');
  }
  function openChatConnInfo() {
    $('#overlayInfoDd').classList.remove('open');
    // La info de conexión tiene su propia pestaña (#rtmpPanel), no es este tab de chat —
    // hay que cambiar de pestaña antes de abrir/scrollear o quedaría oculto.
    if (activeSidebarTab !== 'rtmp') showSidebarTab('rtmp');
    openSubBlock('connChatBlock');
    $('#connChatBlock').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function openSubBlock(id) {
    const block = $('#' + id);
    if (!block) return;
    block.classList.add('open');
    localStorage.setItem('ms_pb_' + id, '1');
  }
  function toggleConnSub(id) {
    const block = $('#' + id);
    const isOpen = block.classList.toggle('open');
    localStorage.setItem('ms_pb_' + id, isOpen ? '1' : '0');
  }
  if (localStorage.getItem('ms_pb_connServerBlock') === '1') $('#connServerBlock').classList.add('open');
  if (localStorage.getItem('ms_pb_connChatBlock') === '1') $('#connChatBlock').classList.add('open');
  if (localStorage.getItem('ms_pb_connStreamDeckBlock') === '1') $('#connStreamDeckBlock').classList.add('open');
  document.addEventListener('click', () => {
    const dd = $('#chatMenuDd');
    if (dd) dd.classList.remove('open');
    const infoDd = $('#overlayInfoDd');
    if (infoDd) infoDd.classList.remove('open');
  });

  async function applyChatMode(btn) {
    const emoteOnly = $('#emoteOnlyChk').checked;
    const subscriberOnly = $('#subOnlyChk').checked;
    const slowOn = $('#slowModeChk').checked;
    const slowSeconds = slowOn ? Math.max(1, Number($('#slowSecondsInput').value) || 30) : 0;
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', '/api/chat-mode', { emoteOnly, subscriberOnly, slowSeconds });
      if (r.ok) toast('Chat de Twitch actualizado');
      else toast(r.error || 'No se pudo aplicar — ¿Twitch conectado?', true);
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function sendChatMessageUi(btn) {
    const input = $('#chatSendInput');
    const text = input.value.trim();
    if (!text) return;
    if (btn) btn.disabled = true;
    try {
      const results = await api('POST', '/api/chat-send', { text });
      const entries = Object.entries(results || {});
      if (!entries.length) { toast('Conecta Twitch o Kick primero.', true); return; }
      const failed = entries.filter(([, r]) => !r.ok);
      if (!failed.length) { input.value = ''; }
      else toast('Falló en ' + failed.map(([p]) => p).join(', '), true);
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  $('#chatSendInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessageUi($('.chat-send-row .chat-popout-btn'));
  });

  async function refresh() {
    if (destBusy) return;
    const activeTag = document.activeElement?.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
    // El ojito de "mostrar clave" solo cambia el type=password/text del <input> existente —
    // pero el poll reconstruye esas tarjetas desde cero (innerHTML) cada 2s, y el input nuevo
    // siempre nace en password. Si hay alguno revelado ahora mismo, no reconstruyas todavía.
    if (document.querySelector('.url[type="text"], .pb-url[type="text"]')) return;
    try { render(await api('GET', '/api/state')); } catch (e) { console.error('[refresh]', e); }
  }

  function copy(id) {
    const el = $('#' + id);
    const text = el.dataset.real || el.textContent;
    if (!text || text === '—') return;
    navigator.clipboard.writeText(text).then(() => toast('Copiado'), () => toast('No se pudo copiar', true));
  }

  let pubIpVisible = false;
  async function togglePubIp() {
    const el = $('#pubRtmpUrl');
    const btn = $('#pubEyeBtn');
    pubIpVisible = !pubIpVisible;
    if (pubIpVisible) {
      if (!el.dataset.real) {
        try {
          const { ip } = await api('GET', '/api/public-ip');
          if (ip && window._rtmpPort) el.dataset.real = 'rtmp://' + ip + ':' + window._rtmpPort + '/live';
        } catch {}
      }
      el.textContent = el.dataset.real || 'No disponible';
    } else {
      el.textContent = 'rtmp://' + '•'.repeat(12) + '/live';
    }
    if (btn) btn.innerHTML = eyeSvg(pubIpVisible);
  }

  let panelTokenVisible = false;
  function togglePanelToken() {
    const el = $('#panelTokenCode');
    const btn = $('#panelTokenEyeBtn');
    panelTokenVisible = !panelTokenVisible;
    el.textContent = panelTokenVisible ? (el.dataset.real || '—') : '•'.repeat(12);
    if (btn) btn.innerHTML = eyeSvg(panelTokenVisible);
  }

  let chatPubIpVisible = false;
  async function toggleChatPubIp() {
    const el = $('#chatPubUrl');
    const btn = $('#chatPubEyeBtn');
    chatPubIpVisible = !chatPubIpVisible;
    if (chatPubIpVisible) {
      if (!el.dataset.real) {
        try {
          const { ip } = await api('GET', '/api/public-ip');
          if (ip) el.dataset.real = 'http://' + ip + ':' + location.port + '/chat-overlay';
        } catch {}
      }
      el.textContent = el.dataset.real || 'No disponible';
    } else {
      el.textContent = 'http://' + '•'.repeat(12) + '/chat-overlay';
    }
    if (btn) btn.innerHTML = eyeSvg(chatPubIpVisible);
  }

  // Alterna type=password/text de cualquier <input> junto a un botón .eye-btn dentro de .eyerow.
  function toggleFieldEye(btn) {
    const input = btn.previousElementSibling;
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = eyeSvg(show);
  }

  // Arranca/para el reproductor flv.js según haya emisión. Solo crea el player
  // cuando OBS publica (si no, el FLV no existe y daría error). También se
  // destruye mientras la ventana está oculta/tapada (Espacios en Mac, minimizada
  // o detrás de otra app en Windows) — si no, el preview queda congelado en el
  // frame de cuando se ocultó y al volver parece un delay real de transmisión,
  // cuando en realidad el relay real (procesos FFmpeg aparte) nunca se detuvo.
  // Monitoreo de audio del preview. El <video> ya recibe el audio del FLV — solo nace
  // con muted. El estado vive en el propio elemento (no en una variable aparte): así
  // sobrevive a que se destruya y recree el player de flv.js al ocultar/mostrar la
  // ventana, sin tener que re-aplicarlo a mano.
  const VOL_OFF_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
  const VOL_ON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';

  function updateMonBtn() {
    const btn = $('#monBtn');
    if (!btn) return;
    const on = !$('#player').muted;
    btn.innerHTML = on ? VOL_ON_SVG : VOL_OFF_SVG;
    btn.classList.toggle('on', on);
    btn.title = on ? 'Silenciar la transmisión' : 'Escuchar la transmisión';
  }

  function togglePreviewAudio() {
    const video = $('#player');
    video.muted = !video.muted;
    updateMonBtn();
  }

  function updatePreview(live) {
    const ph = $('#videoPh');
    const shouldPlay = live && !document.hidden;
    if (shouldPlay && !player) {
      if (!(flvUrl && window.flvjs && flvjs.isSupported())) return;
      const video = $('#player');
      player = flvjs.createPlayer({ type: 'flv', url: flvUrl, isLive: true });
      player.attachMediaElement(video);
      player.load();
      player.play().catch(() => {
        // Reproducir con sonido puede estar bloqueado por la política de autoplay (pasa
        // en un navegador común, no en Electron). Sin esto el preview quedaría en negro
        // sin explicación: se vuelve a mudo — que siempre está permitido — y se reintenta.
        video.muted = true;
        updateMonBtn();
        if (player) player.play().catch(() => {});
      });
      ph.style.display = 'none';
    } else if (!shouldPlay) {
      if (player) { player.destroy(); player = null; }
      // Sin señal: el ícono parpadeando alcanza — decirlo en texto además es redundante
      // con "esperando señal" que ya está en la barra superior. En pausa (ventana en
      // segundo plano) sí es información nueva, esa se queda como texto.
      $('#videoOffIcon').style.display = document.hidden ? 'none' : '';
      $('#videoPhText').textContent = document.hidden ? 'Vista en pausa (ventana en segundo plano)…' : '';
      ph.style.display = 'flex';
    }
  }
  document.addEventListener('visibilitychange', () => {
    updatePreview(lastState ? lastState.live : false);
  });

  async function loadConfig() {
    try {
      const c = await api('GET', '/api/config');
      flvUrl = c.flvUrl || '';
      $('#rtmpUrl').textContent = c.rtmpUrl || '—';
      $('#streamKey').textContent = c.streamKey || '—';
      $('#streamKeyEditInput').value = c.streamKey || '';
      if (c.lanRtmpUrl) {
        $('#lanRtmpUrl').textContent = c.lanRtmpUrl;
        $('#lanField').style.display = '';
      }
      if (c.rtmpPort) {
        window._rtmpPort = c.rtmpPort;
        $('#pubField').style.display = '';
      }
      $('#chatLocalUrl').textContent = location.origin + '/chat-overlay';
      if (c.lanIp) {
        $('#chatLanUrl').textContent = 'http://' + c.lanIp + ':' + location.port + '/chat-overlay';
        $('#chatLanField').style.display = '';
      }
      $('#chatPubField').style.display = '';
      if (c.panelToken) {
        $('#panelTokenCode').dataset.real = c.panelToken;
        $('#panelTokenField').style.display = '';
        $('#panelTokenHint').style.display = 'none';
      }
      if (c.version) window._appVersion = c.version;
      $('#chatCmdChk').checked = c.chatCommandsEnabled !== false;
      $('#audioSilenceChk').checked = c.audioSilenceAlertEnabled !== false;
      window._liveMessage = c.liveMessage || '';
      window._endMessage = c.endMessage || '';
      renderDiscordWebhooks(c.discordWebhooks || []);
      renderTelegramBots(c.telegramBots || []);
    } catch {}
  }

  let recDurSel = 60;
  function setRecDur(dur) {
    recDurSel = dur;
    localStorage.setItem('ms_rec_dur', dur);
    document.querySelectorAll('.rec-dur button').forEach(b =>
      b.classList.toggle('sel', Number(b.dataset.dur) === dur));
    // Persiste server-side ya mismo (no espera a que se arme/desarme el buffer) — así
    // el próximo arranque automático por onPublish() usa esta duración aunque el buffer
    // ya estuviera armado desde antes. Fire-and-forget: si falla, sigue siendo válida
    // la de la sesión anterior, no vale la pena bloquear la UI por esto.
    api('POST', '/api/record/duration', { duration: dur }).catch(() => {});
  }

  // Ajuste persistente server-side (settings.json, ver relays.js armRecording()) — sin
  // señal el backend "arma" en vez de arrancar de una, y lo arranca solo apenas OBS
  // conecte (onPublish). Mismo endpoint sea el panel o el plugin de Stream Deck quien
  // lo llame, así que se comportan siempre igual.
  async function toggleRec() {
    const wantActive = $('#recToggle').checked;
    try {
      await api('POST', wantActive ? '/api/record/start' : '/api/record/stop', { duration: recDurSel });
      if (wantActive && !lastState?.live) toast('Arrancará solo apenas conectes tu software de streaming');
      refresh();
    } catch (e) { toast(e.message, true); }
  }

  async function toggleFullRec() {
    const wantActive = $('#fullRecToggle').checked;
    try {
      const outputDir = $('#recordingsDir').value.trim() || undefined;
      await api('POST', wantActive ? '/api/fullrecord/start' : '/api/fullrecord/stop', { outputDir });
      if (wantActive && !lastState?.live) toast('Arrancará sola apenas conectes tu software de streaming');
      refresh();
    } catch (e) { toast(e.message, true); }
  }

  async function saveStreamKey() {
    const val = $('#streamKeyEditInput').value.trim();
    if (!val) { toast('La clave no puede quedar vacía', true); return; }
    try {
      await api('POST', '/api/stream-key', { streamKey: val });
      toast('Clave actualizada — usá la nueva en tu software de streaming');
      loadConfig();
    } catch (e) { toast(e.message, true); }
  }

  async function browseFolder() {
    try {
      const r = await api('GET', '/api/pick-folder');
      if (r.path) {
        $('#clipsDir').value = r.path;
        localStorage.setItem('ms_clips_dir', r.path);
        setClipsDirServer(r.path);
      }
    } catch (e) {
      // No es Electron: oculta el botón y deja que el usuario escriba a mano
      $('#browseBtn').style.display = 'none';
    }
  }

  async function browseRecordingsFolder() {
    try {
      const r = await api('GET', '/api/pick-folder');
      if (r.path) {
        $('#recordingsDir').value = r.path;
        localStorage.setItem('ms_recordings_dir', r.path);
        setRecordingsDirServer(r.path);
      }
    } catch (e) {
      $('#browseRecordingsBtn').style.display = 'none';
    }
  }

  // Fire-and-forget, igual que setRecDur() — persisten la carpeta elegida en
  // settings.json (ver setClipsDir/setRecordingsDir en relays.js) para que el plugin de
  // Stream Deck (que nunca manda outputDir) guarde en la MISMA carpeta que el panel,
  // en vez de siempre caer en la carpeta default.
  function setClipsDirServer(dir) {
    api('POST', '/api/clips/set-dir', { dir }).catch(() => {});
  }
  function setRecordingsDirServer(dir) {
    api('POST', '/api/recordings/set-dir', { dir }).catch(() => {});
  }

  // Nombres ya anunciados por ESTE panel (guardado propio) — el poll de loadRecentClips()
  // los ignora al detectar "nuevos", para no duplicar el toast de este mismo guardado.
  const announcedClipNames = new Set();

  async function doSaveClip() {
    const btn = $('#clipSaveBtn');
    const outputDir = $('#clipsDir').value.trim() || null;
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const r = await api('POST', '/api/record/save', { duration: recDurSel, outputDir });
      const name = r.path ? r.path.split(/[\\/]/).pop() : '';
      if (name) announcedClipNames.add(name);
      toast('✓ Clip guardado' + (name ? ': ' + name : ''));
      loadRecentClips();
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; btn.textContent = 'Guardar clip'; }
  }

  async function openClipsFolder() {
    if (!window.msApp) return;
    try {
      const outputDir = $('#clipsDir').value.trim() || null;
      const q = outputDir ? '?dir=' + encodeURIComponent(outputDir) : '';
      const { dir } = await api('GET', '/api/clips' + q);
      await api('POST', '/api/clips/open', { path: dir });
    } catch (e) {
      toast(e.message, true);
    }
  }

  function fmtClipSize(bytes) {
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  // Construido en el cliente en tiempo de ejecución — translateHtml() traduce el HTML
  // servido una sola vez, no puede alcanzar texto armado después con JS. document.documentElement.lang
  // sí queda en 'en'/'es' correcto (ese <html lang="es"> es el primer key de tMap), así
  // que sirve como señal confiable del idioma actual sin duplicar todo el mecanismo de i18n.
  function fmtClipAge(mtime) {
    const mins = Math.floor((Date.now() - mtime) / 60000);
    if (mins < 1) return pick({ es: 'ahora mismo', en: 'just now', fr: "à l'instant", pt: 'agora mesmo' });
    if (mins < 60) return pick({ es: 'hace ' + mins + ' min', en: mins + ' min ago', fr: 'il y a ' + mins + ' min', pt: 'há ' + mins + ' min' });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return pick({ es: 'hace ' + hrs + 'h', en: hrs + 'h ago', fr: 'il y a ' + hrs + 'h', pt: 'há ' + hrs + 'h' });
    const days = Math.floor(hrs / 24);
    return pick({ es: 'hace ' + days + 'd', en: days + 'd ago', fr: 'il y a ' + days + 'j', pt: 'há ' + days + 'd' });
  }
  const CLIP_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>';

  const CLIP_DEL_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

  // null = todavía no cargó ninguna vez (recién abrió el panel) — no hay que anunciar
  // como "nuevos" clips que ya existían de antes, solo los que aparecen DESPUÉS del
  // primer load. Distinto de announcedClipNames: esto es "qué vi la última vez",
  // aquello es "cuáles ya avisé yo mismo" (para no duplicar el toast del guardado local).
  let seenClipNames = null;

  async function loadRecentClips() {
    if (!window.msApp) return;
    try {
      const outputDir = $('#clipsDir').value.trim() || null;
      const q = outputDir ? '?dir=' + encodeURIComponent(outputDir) : '';
      const { files, total } = await api('GET', '/api/clips' + q);
      // Guardado desde OTRO cliente (ej. Stream Deck) — el panel no tiene forma de
      // saberlo salvo comparando con la última lista que vio. Sin esto, un clip
      // guardado por el plugin no daba ninguna señal en la app hasta que el usuario
      // notaba que apareció solo en la lista (o ni eso, si no la tenía abierta).
      if (seenClipNames) {
        for (const f of files) {
          if (seenClipNames.has(f.name)) continue;
          if (announcedClipNames.delete(f.name)) continue; // ya avisado por doSaveClip()
          toast('✓ Clip guardado: ' + f.name);
        }
      }
      seenClipNames = new Set(files.map((f) => f.name));
      const box = $('#recentClips');
      const list = $('#recentClipsList');
      if (!files.length) { box.style.display = 'none'; return; }
      box.style.display = '';
      list.innerHTML = '';
      for (const f of files) {
        const item = document.createElement('div');
        item.className = 'recent-clip-item';
        item.innerHTML = CLIP_ICON_SVG +
          '<div class="recent-clip-info">' +
          '<div class="recent-clip-name"></div>' +
          '<div class="recent-clip-meta"></div>' +
          '</div>' +
          '<button class="recent-clip-del" title="Borrar">' + CLIP_DEL_ICON_SVG + '</button>';
        item.querySelector('.recent-clip-name').textContent = f.name;
        item.querySelector('.recent-clip-meta').textContent = fmtClipAge(f.mtime) + ' · ' + fmtClipSize(f.size);
        item.addEventListener('click', () => revealClip(f.path));
        item.querySelector('.recent-clip-del').addEventListener('click', (e) => {
          e.stopPropagation();
          deleteClip(f.path);
        });
        list.appendChild(item);
      }
      if (total > files.length) {
        const more = document.createElement('div');
        more.className = 'recent-clips-more';
        const moreN = total - files.length;
        more.textContent = pick({
          es: 'y ' + moreN + ' más — abrir carpeta',
          en: 'and ' + moreN + ' more — open folder',
          fr: 'et ' + moreN + ' de plus — ouvrir le dossier',
          pt: 'e mais ' + moreN + ' — abrir pasta',
        });
        more.addEventListener('click', openClipsFolder);
        list.appendChild(more);
      }
    } catch {}
  }

  async function revealClip(clipPath) {
    try { await api('POST', '/api/clips/open', { path: clipPath, reveal: true }); }
    catch (e) { toast(e.message, true); }
  }

  async function deleteClip(clipPath) {
    try {
      const outputDir = $('#clipsDir').value.trim() || null;
      await api('DELETE', '/api/clips', { path: clipPath, outputDir });
      loadRecentClips();
    } catch (e) { toast(e.message, true); }
  }

  async function openRecordingsFolder() {
    if (!window.msApp) return;
    try {
      const outputDir = $('#recordingsDir').value.trim() || null;
      const q = outputDir ? '?dir=' + encodeURIComponent(outputDir) : '';
      const { dir } = await api('GET', '/api/recordings' + q);
      await api('POST', '/api/clips/open', { path: dir }); // ruta genérica, sirve para cualquier carpeta
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function loadRecentRecordings() {
    if (!window.msApp) return;
    try {
      const outputDir = $('#recordingsDir').value.trim() || null;
      const q = outputDir ? '?dir=' + encodeURIComponent(outputDir) : '';
      const { files, total } = await api('GET', '/api/recordings' + q);
      const box = $('#recentRecordings');
      const list = $('#recentRecordingsList');
      if (!files.length) { box.style.display = 'none'; return; }
      box.style.display = '';
      list.innerHTML = '';
      for (const f of files) {
        const item = document.createElement('div');
        item.className = 'recent-clip-item';
        item.innerHTML = CLIP_ICON_SVG +
          '<div class="recent-clip-info">' +
          '<div class="recent-clip-name"></div>' +
          '<div class="recent-clip-meta"></div>' +
          '</div>' +
          '<button class="recent-clip-del" title="Borrar">' + CLIP_DEL_ICON_SVG + '</button>';
        item.querySelector('.recent-clip-name').textContent = f.name;
        item.querySelector('.recent-clip-meta').textContent = fmtClipAge(f.mtime) + ' · ' + fmtClipSize(f.size);
        item.addEventListener('click', () => revealRecording(f.path));
        item.querySelector('.recent-clip-del').addEventListener('click', (e) => {
          e.stopPropagation();
          deleteRecording(f.path);
        });
        list.appendChild(item);
      }
      if (total > files.length) {
        const more = document.createElement('div');
        more.className = 'recent-clips-more';
        const moreN = total - files.length;
        more.textContent = pick({
          es: 'y ' + moreN + ' más — abrir carpeta',
          en: 'and ' + moreN + ' more — open folder',
          fr: 'et ' + moreN + ' de plus — ouvrir le dossier',
          pt: 'e mais ' + moreN + ' — abrir pasta',
        });
        more.addEventListener('click', openRecordingsFolder);
        list.appendChild(more);
      }
    } catch {}
  }

  async function revealRecording(recordingPath) {
    try { await api('POST', '/api/clips/open', { path: recordingPath, reveal: true }); }
    catch (e) { toast(e.message, true); }
  }

  async function deleteRecording(recordingPath) {
    try {
      const outputDir = $('#recordingsDir').value.trim() || null;
      await api('DELETE', '/api/recordings', { path: recordingPath, outputDir });
      loadRecentRecordings();
    } catch (e) { toast(e.message, true); }
  }

  async function loadOrphanRecordings() {
    if (!window.msApp) return;
    try {
      const outputDir = $('#recordingsDir').value.trim() || null;
      const q = outputDir ? '?dir=' + encodeURIComponent(outputDir) : '';
      const { files } = await api('GET', '/api/recordings/orphans' + q);
      const box = $('#orphanRecordingsBlock');
      const list = $('#orphanRecordingsList');
      if (!files.length) { box.style.display = 'none'; return; }
      box.style.display = '';
      list.innerHTML = '';
      for (const f of files) {
        const item = document.createElement('div');
        item.className = 'recent-clip-item';
        item.style.cursor = 'default';
        item.innerHTML = CLIP_ICON_SVG +
          '<div class="recent-clip-info">' +
          '<div class="recent-clip-name"></div>' +
          '<div class="recent-clip-meta"></div>' +
          '</div>' +
          '<button class="browse-btn orphan-convert-btn" style="width:auto;padding:.35rem .7rem;font-size:.75rem">Convertir a MP4</button>' +
          '<button class="danger-btn orphan-del-btn" style="width:auto;padding:.35rem .7rem;font-size:.75rem;margin-left:.35rem">Eliminar</button>';
        item.querySelector('.recent-clip-name').textContent = f.name;
        item.querySelector('.recent-clip-meta').textContent = fmtClipAge(f.mtime) + ' · ' + fmtClipSize(f.size);
        item.querySelector('.orphan-convert-btn').addEventListener('click', (e) => convertOrphan(f.path, e.currentTarget));
        item.querySelector('.orphan-del-btn').addEventListener('click', () => deleteOrphan(f.path, f.name));
        list.appendChild(item);
      }
    } catch {}
  }

  async function convertOrphan(tsPath, btn) {
    const outputDir = $('#recordingsDir').value.trim() || null;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Convirtiendo…';
    try {
      const r = await api('POST', '/api/recordings/convert', { path: tsPath, outputDir });
      const name = r.path ? r.path.split(/[\\/]/).pop() : '';
      toast('✓ Convertido: ' + name);
      loadOrphanRecordings();
      loadRecentRecordings();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  // Borra un .ts huérfano SIN convertirlo — para cuando el usuario no lo quiere guardar.
  // Confirmación de por medio a propósito: a diferencia de un .mp4 ya guardado, este es
  // crudo y único (viene de un cierre inesperado) — no hay otra copia si se borra por error.
  async function deleteOrphan(tsPath, name) {
    const ok = await showConfirm('¿Eliminar "' + name + '" sin convertir? No se puede deshacer.', 'Eliminar');
    if (!ok) return;
    try {
      const outputDir = $('#recordingsDir').value.trim() || null;
      await api('DELETE', '/api/recordings', { path: tsPath, outputDir });
      toast('Eliminado: ' + name);
      loadOrphanRecordings();
    } catch (e) { toast(e.message, true); }
  }

  // Restaura preferencias guardadas en sesiones anteriores — y las re-sincroniza al
  // servidor ya mismo (fire-and-forget). Necesario para quien ya tenía una carpeta/
  // duración elegida en localStorage de ANTES de que existiera la persistencia
  // server-side: sin este push, settings.json se queda en null/default para siempre,
  // porque el onchange/setRecDur() normal solo dispara con una edición NUEVA, no por
  // tener ya un valor cargado desde localStorage.
  const savedDir = localStorage.getItem('ms_clips_dir');
  if (savedDir) { $('#clipsDir').value = savedDir; setClipsDirServer(savedDir); }
  const savedRecordingsDir = localStorage.getItem('ms_recordings_dir');
  if (savedRecordingsDir) { $('#recordingsDir').value = savedRecordingsDir; setRecordingsDirServer(savedRecordingsDir); }
  const savedDur = Number(localStorage.getItem('ms_rec_dur'));
  if ([60, 300, 600, 900].includes(savedDur)) setRecDur(savedDur);
  loadChatKeywords();

  if (window.msApp) {
    loadRecentClips();
    loadRecentRecordings();
    setInterval(loadRecentClips, 20000);
    setInterval(loadRecentRecordings, 20000);
  } else {
    $('#openClipsFolderBtn').style.display = 'none';
    $('#openRecordingsFolderBtn').style.display = 'none';
  }

  // ── Canvas fondo: nodos conectados ──
  (function initBg() {
    const canvas = document.getElementById('bgCanvas');
    const ctx = canvas.getContext('2d');
    const N = 18, D = 170, FPS = 15, MS = 1000 / FPS;
    let nodes = [], last = 0;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function resize() {
      canvas.width = innerWidth; canvas.height = innerHeight;
      nodes = Array.from({length: N}, () => ({
        x: Math.random() * canvas.width, y: Math.random() * canvas.height,
        vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35,
      }));
    }
    function draw(ts) {
      if (!reduceMotion) requestAnimationFrame(draw);
      if (ts - last < MS) return;
      last = ts;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const light = document.documentElement.dataset.theme === 'light';
      const nodeColor = light ? 'rgba(124,92,255,.45)' : 'rgba(124,92,255,.55)';
      for (let i = 0; i < N; i++) {
        const a = nodes[i];
        a.x += a.vx; a.y += a.vy;
        if (a.x < 0 || a.x > canvas.width) a.vx *= -1;
        if (a.y < 0 || a.y > canvas.height) a.vy *= -1;
        for (let j = i + 1; j < N; j++) {
          const b = nodes[j], dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < D) {
            const alpha = (.12 * (1 - dist / D)).toFixed(3);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = 'rgba(124,92,255,' + alpha + ')'; ctx.lineWidth = .8; ctx.stroke();
          }
        }
        ctx.beginPath(); ctx.arc(a.x, a.y, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = nodeColor; ctx.fill();
      }
    }
    resize();
    window.addEventListener('resize', resize);
    if (reduceMotion) draw(0); else requestAnimationFrame(draw);
  })();

  // ── Tema claro/oscuro ──
  // En Windows, la barra de título fundida (titleBarOverlay) tiene su color fijado por
  // Electron al crear la ventana — hay que avisarle cada vez que cambia el tema, si no
  // se queda desincronizada (justo el problema original: la barra no seguía el tema).
  function syncTitleBarTheme() {
    if (window.msApp && window.msApp.setTitleBarTheme) {
      window.msApp.setTitleBarTheme(document.documentElement.dataset.theme !== 'light');
    }
  }
  // Mismo origen (http://localhost:19080) que la ventana de chat flotante — le avisa
  // el tema en vivo sin necesitar una vuelta por Electron IPC.
  let themeChannel = null;
  try { themeChannel = new BroadcastChannel('muxlyve-theme'); } catch {}

  function toggleTheme() {
    const dark = $('#themeChk').checked;
    const next = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = dark ? '' : 'light';
    localStorage.setItem('ms_theme', next);
    syncTitleBarTheme();
    if (themeChannel) themeChannel.postMessage(next);
  }
  const savedTheme = localStorage.getItem('ms_theme');
  if (savedTheme === 'light') {
    document.documentElement.dataset.theme = 'light';
  }
  syncTitleBarTheme();
  const savedTitle = localStorage.getItem('ms_stream_title');
  if (savedTitle) $('#titleInput').value = savedTitle;
  const savedCategory = localStorage.getItem('ms_stream_category');
  if (savedCategory) $('#categoryInput').value = savedCategory;
  updateStreamTitleDisplay();

  // ── Wordmark animation: Muxlyve → Muxly Live ──
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    (function() {
      const li = document.getElementById('wmLi');
      if (!li) return;
      function cycle() {
        li.classList.toggle('show');
        setTimeout(cycle, li.classList.contains('show')
          ? 2500 + Math.random() * 2000
          : 5000 + Math.random() * 5000);
      }
      setTimeout(cycle, 2500 + Math.random() * 1500);
    })();
  }

  function closeConnInfoAndOpenPrefs(e) {
    e.preventDefault();
    openPrefs();
  }
  async function openPrefs() {
    $('#prefsOverlay').classList.add('open');
    $('#themeChk').checked = document.documentElement.dataset.theme !== 'light';
    loadLicenseInfo();
    loadOrphanRecordings();
    loadSessionHistory();
    const hasElectron = !!window.msApp;
    $('#prefsNavSys').style.display = hasElectron ? '' : 'none';
    $('#prefsNavSupport').style.display = hasElectron ? '' : 'none';
    const available = hasElectron ? ['sys', 'clips', 'webhooks', 'history', 'support', 'license'] : ['clips', 'webhooks', 'history', 'license'];
    const stored = localStorage.getItem('ms_prefs_tab');
    switchPrefsTab(available.includes(stored) ? stored : available[0]);
    if (hasElectron) {
      try {
        const s = await window.msApp.getLoginItem();
        $('#loginItemChk').checked = s.openAtLogin;
        $('#startMinChk').checked = s.startMinimized;
        $('#startMinRow').style.display = s.openAtLogin ? '' : 'none';
        $('#closeToTrayChk').checked = await window.msApp.getCloseToTray();
        $('#allowLanChk').checked = await window.msApp.getAllowLanPanel();
        markActiveLanguageBtn(await window.msApp.getLanguage());
      } catch {}
    }
  }
  function switchPrefsTab(tab) {
    document.querySelectorAll('.prefs-nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    document.querySelectorAll('.prefs-panel').forEach(el => el.classList.toggle('active', el.dataset.panel === tab));
    localStorage.setItem('ms_prefs_tab', tab);
  }
  function closePrefs() { $('#prefsOverlay').classList.remove('open'); }
  function markActiveLanguageBtn(lang) {
    const sel = $('#langSelect');
    if (sel) sel.value = lang;
  }
  async function setAppLanguage(lang) {
    if (!window.msApp?.setLanguage) return;
    await window.msApp.setLanguage(lang);
  }
  async function toggleLoginItem() {
    if (!window.msApp) return;
    const openAtLogin = $('#loginItemChk').checked;
    const startMinimized = $('#startMinChk').checked;
    $('#startMinRow').style.display = openAtLogin ? '' : 'none';
    try { await window.msApp.setLoginItem(openAtLogin, startMinimized); } catch {}
  }
  async function toggleCloseToTray() {
    if (!window.msApp) return;
    try { await window.msApp.setCloseToTray($('#closeToTrayChk').checked); } catch {}
  }
  async function toggleAllowLan() {
    if (!window.msApp) return;
    try {
      await window.msApp.setAllowLanPanel($('#allowLanChk').checked);
      $('#allowLanRestartRow').style.display = '';
    } catch {}
  }
  async function relaunchApp() {
    if (!window.msApp) return;
    try { await window.msApp.relaunchApp(); } catch {}
  }

  // Ajustes del motor (settings.json vía /api/settings) — no de Electron, funcionan
  // igual con la app de escritorio o el panel servido a un navegador cualquiera.
  async function toggleChatCommands() {
    try { await api('POST', '/api/settings', { chatCommandsEnabled: $('#chatCmdChk').checked }); }
    catch (e) { toast(e.message, true); }
  }
  async function toggleAudioSilenceAlert() {
    try { await api('POST', '/api/settings', { audioSilenceAlertEnabled: $('#audioSilenceChk').checked }); }
    catch (e) { toast(e.message, true); }
  }

  // Exportar/importar configuración (Fase 1 del lote 2, docs/PLAN_FEATURES_LOTE2.md).
  // Descarga un archivo con destinos + ajustes — GET /api/config/export ya arma el JSON
  // del motor; acá solo se le agrega quién lo exportó (correo de la licencia, si hay
  // Electron) y se dispara la descarga vía Blob (sin pedirle nada especial al servidor).
  async function exportConfig() {
    try {
      const data = await api('GET', '/api/config/export');
      const info = await window.msLicense?.getInfo().catch(() => null);
      data.license = { email: info?.email || null };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'muxlyve-config-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Configuración exportada');
    } catch (e) {
      toast(e.message, true);
    }
  }

  // Antes de mandar el archivo al servidor, compara el correo de licencia con el que
  // quedó guardado adentro del archivo (ver exportConfig arriba) — si las dos existen y
  // NO coinciden, es casi seguro que este archivo es de otra persona (alguien más lo
  // exportó, o lo compartieron sin querer). No lo bloquea del todo — migrar entre tus
  // propias máquinas es exactamente el caso de uso que esto existe para resolver — pero
  // ya no puede pasar en silencio: hace falta confirmar explícitamente el mismatch.
  // Sin Electron (panel servido a un navegador cualquiera) no hay con qué comparar, se
  // salta el chequeo — mismo criterio que cualquier otra función Electron-only.
  async function importConfig(file) {
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast('El archivo no es un JSON válido.', true);
      return;
    }
    if (!Array.isArray(parsed.destinations) || !parsed.settings) {
      toast('El archivo no tiene el formato esperado (¿es un export de Muxlyve?).', true);
      return;
    }
    const fileEmail = parsed.license?.email || null;
    const info = await window.msLicense?.getInfo().catch(() => null);
    const currentEmail = info?.email || null;
    if (fileEmail && currentEmail && fileEmail !== currentEmail) {
      const ok = await showConfirm(
        'Este archivo fue exportado desde otra cuenta (' + fileEmail + '), no la que está activa en este equipo (' + currentEmail + '). ¿Importar igual?',
        'Importar de todas formas',
      );
      if (!ok) return;
    }
    try {
      await api('POST', '/api/config/import', { destinations: parsed.destinations, settings: parsed.settings });
      toast('Configuración importada');
      $('#importConfigInput').value = ''; // permite volver a elegir el mismo archivo despues
      refresh();
      loadConfig();
    } catch (e) {
      toast(e.message, true);
    }
  }
  // Webhooks de Discord (hasta 3) y bots de Telegram (hasta 3) — Preferencias → Webhooks.
  // Arrays en memoria, poblados por loadConfig()/render*() al abrir el panel; cada cambio
  // (agregar/borrar/editar una fila) persiste el array COMPLETO vía POST /api/settings —
  // el backend valida cada entrada y el tope, ver src/panel.js handleApi.
  const MAX_DISCORD_WEBHOOKS = 3;
  const MAX_TELEGRAM_BOTS = 3;
  window._discordWebhooks = window._discordWebhooks || [];
  window._telegramBots = window._telegramBots || [];

  function renderDiscordWebhooks(list) {
    window._discordWebhooks = list.slice();
    const box = $('#discordWebhooksList');
    box.innerHTML = '';
    window._discordWebhooks.forEach((url, i) => {
      const row = document.createElement('div');
      row.className = 'webhook-row';
      row.innerHTML =
        '<input type="text" placeholder="https://discord.com/api/webhooks/…">' +
        '<button class="browse-btn webhook-test-btn">Probar</button>' +
        '<button class="webhook-del-btn" title="Borrar">✕</button>';
      const input = row.querySelector('input');
      input.value = url;
      input.addEventListener('change', () => updateDiscordWebhook(i, input.value));
      row.querySelector('.webhook-test-btn').addEventListener('click', () => testDiscordWebhookRow(input.value));
      row.querySelector('.webhook-del-btn').addEventListener('click', () => removeDiscordWebhook(i));
      box.appendChild(row);
    });
    $('#addDiscordWebhookBtn').style.display = window._discordWebhooks.length >= MAX_DISCORD_WEBHOOKS ? 'none' : '';
  }
  function addDiscordWebhookRow() {
    if (window._discordWebhooks.length >= MAX_DISCORD_WEBHOOKS) return;
    renderDiscordWebhooks([...window._discordWebhooks, '']);
    const inputs = $('#discordWebhooksList').querySelectorAll('input');
    inputs[inputs.length - 1]?.focus();
  }
  async function updateDiscordWebhook(i, value) {
    const next = window._discordWebhooks.slice();
    next[i] = value.trim();
    await persistDiscordWebhooks(next);
  }
  async function removeDiscordWebhook(i) {
    const next = window._discordWebhooks.filter((_, idx) => idx !== i);
    await persistDiscordWebhooks(next);
  }
  async function persistDiscordWebhooks(list) {
    const cleaned = list.filter((u) => u && u.trim());
    try {
      await api('POST', '/api/settings', { discordWebhooks: cleaned });
      renderDiscordWebhooks(cleaned);
      toast('Webhooks de Discord actualizados');
    } catch (e) { toast(e.message, true); } // no re-renderiza — no pisa lo que el usuario tiene escrito
  }
  async function testDiscordWebhookRow(url) {
    try {
      const r = await api('POST', '/api/notify-test-discord', { url });
      toast(r.ok ? 'Aviso de prueba enviado a Discord' : (r.error || 'No se pudo enviar'), !r.ok);
    } catch (e) { toast(e.message, true); }
  }

  function renderTelegramBots(list) {
    window._telegramBots = list.slice();
    const box = $('#telegramBotsList');
    box.innerHTML = '';
    window._telegramBots.forEach((bot, i) => {
      const row = document.createElement('div');
      row.className = 'webhook-row webhook-row-telegram';
      row.innerHTML =
        '<input type="text" class="tg-token" placeholder="Token del bot (@BotFather)">' +
        '<input type="text" class="tg-chat" placeholder="Chat ID">' +
        '<button class="browse-btn webhook-save-btn">Guardar</button>' +
        '<button class="browse-btn webhook-test-btn">Probar</button>' +
        '<button class="webhook-del-btn" title="Borrar">✕</button>';
      const tokenInput = row.querySelector('.tg-token');
      const chatInput = row.querySelector('.tg-chat');
      tokenInput.value = bot.botToken;
      chatInput.value = bot.chatId;
      row.querySelector('.webhook-save-btn').addEventListener('click', () => saveTelegramBotRow(i, tokenInput.value, chatInput.value));
      row.querySelector('.webhook-test-btn').addEventListener('click', () => testTelegramBotRow(tokenInput.value, chatInput.value));
      row.querySelector('.webhook-del-btn').addEventListener('click', () => removeTelegramBot(i));
      box.appendChild(row);
    });
    $('#addTelegramBotBtn').style.display = window._telegramBots.length >= MAX_TELEGRAM_BOTS ? 'none' : '';
  }
  function addTelegramBotRow() {
    if (window._telegramBots.length >= MAX_TELEGRAM_BOTS) return;
    renderTelegramBots([...window._telegramBots, { botToken: '', chatId: '' }]);
    const inputs = $('#telegramBotsList').querySelectorAll('.tg-token');
    inputs[inputs.length - 1]?.focus();
  }
  // Guarda solo al tocar "Guardar" — a diferencia de Discord (un solo campo, autosave al
  // salir del input anda bien), Telegram necesita token Y chat ID juntos para ser válido:
  // autosave por campo guardaba apenas se completaba el token (sin chat ID todavía),
  // el backend lo rechazaba, y el error volvía a pintar la fila con el valor viejo —
  // borrando lo que el usuario acababa de escribir. Ver .webhook-row-telegram en el CSS.
  async function saveTelegramBotRow(i, botToken, chatId) {
    const next = window._telegramBots.slice();
    next[i] = { botToken: botToken.trim(), chatId: chatId.trim() };
    await persistTelegramBots(next);
  }
  async function removeTelegramBot(i) {
    const next = window._telegramBots.filter((_, idx) => idx !== i);
    await persistTelegramBots(next);
  }
  async function persistTelegramBots(list) {
    const cleaned = list.filter((b) => b.botToken || b.chatId);
    try {
      await api('POST', '/api/settings', { telegramBots: cleaned });
      renderTelegramBots(cleaned);
      toast('Bots de Telegram actualizados');
    } catch (e) { toast(e.message, true); } // no re-renderiza — no pisa lo que el usuario tiene escrito
  }
  async function testTelegramBotRow(botToken, chatId) {
    try {
      const r = await api('POST', '/api/notify-test-telegram', { botToken, chatId });
      toast(r.ok ? 'Aviso de prueba enviado a Telegram' : (r.error || 'No se pudo enviar'), !r.ok);
    } catch (e) { toast(e.message, true); }
  }

  // Modal de mensaje de aviso (Discord + Telegram) — acceso rápido desde la grilla 2x2,
  // ver el botón en stream-actions-grid. Un solo modal para los dos mensajes (al iniciar /
  // al finalizar), con pestañas en vez de un segundo botón en la grilla — msgTabKind
  // guarda cuál se está editando ahora mismo. window._liveMessage/_endMessage se cargan en
  // loadConfig() y se mantienen en memoria para no tener que pedirlos de nuevo cada vez.
  let msgTabKind = 'start';
  const MSG_TAB_META = {
    start: {
      desc: 'Se manda a los webhooks de Discord y bots de Telegram configurados (Preferencias → Webhooks) apenas empieza la transmisión. Discord admite su formato (**negrita**, *itálica*, enlaces) — Telegram lo muestra como texto plano.',
      placeholder: '🔴 ¡La transmisión empezó!',
    },
    end: {
      desc: 'Se manda a los mismos canales apenas termina la transmisión. Mismo formato que el de inicio (Discord admite **negrita**/*itálica*/enlaces, Telegram lo muestra como texto plano).',
      placeholder: '⚫ La transmisión terminó.',
    },
  };
  function switchMsgTab(kind) {
    msgTabKind = kind;
    $('#msgTabStart').classList.toggle('active', kind === 'start');
    $('#msgTabEnd').classList.toggle('active', kind === 'end');
    const meta = MSG_TAB_META[kind];
    $('#discordMsgDesc').textContent = meta.desc;
    $('#discordMsgInput').placeholder = meta.placeholder;
    $('#discordMsgInput').value = (kind === 'start' ? window._liveMessage : window._endMessage) || '';
    updateDiscordMsgCount();
  }
  function openDiscordMsgModal() {
    switchMsgTab('start'); // siempre arranca en "al iniciar", sea cual sea la pestaña que quedó activa la última vez
    $('#discordMsgOverlay').classList.add('open');
  }
  function closeDiscordMsgModal() { $('#discordMsgOverlay').classList.remove('open'); }
  function updateDiscordMsgCount() {
    $('#discordMsgCount').textContent = $('#discordMsgInput').value.length + ' / 2000';
  }
  async function saveDiscordMsgModal() {
    const value = $('#discordMsgInput').value.trim();
    const field = msgTabKind === 'start' ? 'liveMessage' : 'endMessage';
    try {
      await api('POST', '/api/settings', { [field]: value });
      if (msgTabKind === 'start') window._liveMessage = value; else window._endMessage = value;
      toast('Mensaje de aviso guardado');
      closeDiscordMsgModal();
    } catch (e) { toast(e.message, true); }
  }
  // Prueba TODOS los canales configurados de una, con el mensaje de la pestaña activa —
  // usa el mensaje YA GUARDADO (si hay ediciones sin guardar en el textarea, "Guardar"
  // primero). Toast resume cuántos salieron bien; si alguno falló, el primer error queda
  // de referencia.
  async function testAllChannelsUi() {
    try {
      const { results } = await api('POST', '/api/notify-test-all', { kind: msgTabKind });
      if (!results.length) { toast('No hay ningún webhook o bot configurado todavía', true); return; }
      const okCount = results.filter((r) => r.ok).length;
      const firstError = results.find((r) => !r.ok);
      if (okCount === results.length) toast('Aviso de prueba enviado a los ' + okCount + ' canales configurados');
      else toast(okCount + '/' + results.length + ' enviados — ' + (firstError?.error || 'revisa Webhooks en Preferencias'), okCount === 0);
    } catch (e) { toast(e.message, true); }
  }

  async function checkForUpdates() {
    if (!window.msApp) return;
    const btn = $('#updateCheckBtn');
    btn.disabled = true;
    btn.textContent = 'Buscando…';
    try {
      const r = await window.msApp.checkForUpdates();
      if (!r.ok) { toast(r.error, true); }
      // Si sí hay algo que buscar, el resultado (hay/no hay actualización) llega vía un
      // diálogo nativo del proceso principal, no por aquí — este solo confirma el disparo.
    } catch (e) {
      toast(e.message, true);
    }
    btn.disabled = false;
    btn.textContent = 'Buscar';
  }

  function openReport() { $('#reportOverlay').classList.add('open'); }
  function closeReport() { $('#reportOverlay').classList.remove('open'); }

  async function sendReport() {
    if (!window.msApp) return;
    const btn = $('#reportSendBtn');
    const desc = $('#reportDesc').value.trim();
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const r = await window.msApp.sendReport(desc);
      if (r.ok) {
        toast('✓ Reporte enviado — gracias');
        $('#reportDesc').value = '';
        closeReport();
      } else {
        toast(r.error || 'No se pudo enviar el reporte', true);
      }
    } catch (e) {
      toast(e.message, true);
    }
    btn.disabled = false;
    btn.textContent = 'Enviar reporte';
  }

  function openFeedback() { $('#feedbackOverlay').classList.add('open'); }
  function closeFeedback() { $('#feedbackOverlay').classList.remove('open'); }

  async function sendFeedback() {
    if (!window.msApp) return;
    const btn = $('#feedbackSendBtn');
    const desc = $('#feedbackDesc').value.trim();
    if (!desc) { toast('Escribe algo primero', true); return; }
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const r = await window.msApp.sendFeedback(desc);
      if (r.ok) {
        toast('✓ Idea enviada — gracias');
        $('#feedbackDesc').value = '';
        closeFeedback();
      } else {
        toast(r.error || 'No se pudo enviar', true);
      }
    } catch (e) {
      toast(e.message, true);
    }
    btn.disabled = false;
    btn.textContent = 'Enviar idea';
  }

  async function loadLicenseInfo() {
    $('#licEmail').textContent = '…';
    const info = await window.msLicense?.getStatus().catch(() => window.msLicense?.getInfo());
    if (!info) { $('#licEmail').textContent = '—'; return; }

    $('#licEmail').textContent = info.email || '—';

    const planLabels = { monthly: 'Mensual', annual: 'Anual', lifetime: 'Vitalicio' };
    $('#licPlan').textContent = planLabels[info.plan] || info.plan || 'Vitalicio';

    const badge = $('#licBadge');
    if (info.plan === 'lifetime') {
      badge.textContent = 'Vitalicio'; badge.className = 'lic-badge lifetime';
    } else if (info.status === 'cancelled') {
      badge.textContent = 'Cancelada'; badge.className = 'lic-badge cancelled';
    } else {
      badge.textContent = 'Activa'; badge.className = 'lic-badge active';
    }

    const renewRow = $('#licRenewRow');
    if (info.plan === 'lifetime') {
      renewRow.style.display = 'none';
    } else {
      renewRow.style.display = '';
      const ts = info.status === 'cancelled' ? info.expiresAt : info.renewsAt;
      $('#licRenewLabel').textContent = info.status === 'cancelled' ? 'Se cancela el' : 'Se renueva el';
      $('#licRenewDate').textContent = ts
        ? new Date(ts).toLocaleDateString('es', { year: 'numeric', month: 'long', day: 'numeric' })
        : '—';
    }

    $('#licDate').textContent = info.activatedAt
      ? new Date(info.activatedAt).toLocaleDateString('es', { year: 'numeric', month: 'long', day: 'numeric' })
      : '—';

    $('#licManageBtn').style.display = info.plan !== 'lifetime' ? '' : 'none';
  }

  function openAbout() {
    // Versión ya cargada en init (appVersion global); año dinámico
    $('#aboutVersion').textContent = 'v' + (window._appVersion || '—');
    $('#aboutCopy').innerHTML = '© ' + new Date().getFullYear() + ' Muxlyve. Todos los derechos reservados.<br>Muxlyve es software propietario. Prohibida su distribución sin autorización.';
    $('#aboutOverlay').classList.add('open');
  }
  function closeAbout() { $('#aboutOverlay').classList.remove('open'); }

  // Botón secundario, estilo bordeado (mismo que "Acerca de Muxlyve"/"Gestionar
  // suscripción" en Licencia) — .lic-manage-btn. Primario: .browse-btn (morado sólido).
  function updaterBtn(label, primary, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = primary ? 'browse-btn' : 'lic-manage-btn';
    btn.style.width = '100%';
    btn.onclick = onClick;
    return btn;
  }
  // 'available' no abre el modal solo — queda pendiente y solo se ve un ícono discreto
  // sobre Ajustes (ver #updateBtn). El usuario decide cuándo ver el aviso completo.
  let pendingUpdatePayload = null;
  function openUpdaterModal() {
    if (!pendingUpdatePayload) return;
    $('#updateBtn').style.display = 'none';
    handleUpdaterEvent(pendingUpdatePayload);
  }
  function closeUpdaterModal() {
    $('#updaterOverlay').classList.remove('open');
    // Si cerró sin descargar (p.ej. "Ahora no"), la actualización sigue pendiente —
    // el ícono vuelve para que pueda retomarlo cuando quiera.
    if (pendingUpdatePayload) $('#updateBtn').style.display = 'flex';
  }
  function fmtMBs(bytesPerSecond) {
    return (bytesPerSecond / (1024 * 1024)).toFixed(1) + ' MB/s';
  }

  const VIEWER_PLATFORM_LABELS = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' };
  function summaryRow(label, value) {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.gap = '1rem';
    const l = document.createElement('span');
    l.style.color = 'var(--muted)';
    l.textContent = label;
    const v = document.createElement('strong');
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }
  function closeSessionSummary() { $('#summaryOverlay').classList.remove('open'); }
  function showSessionSummary() {
    const body = $('#summaryBody');
    body.innerHTML = '';
    body.appendChild(summaryRow('Duración', fmtUptime(sessionLastUptime)));
    for (const p of ['twitch', 'kick', 'youtube']) {
      if (sessionPeakViewers[p] > 0) {
        body.appendChild(summaryRow('Pico ' + VIEWER_PLATFORM_LABELS[p], sessionPeakViewers[p].toLocaleString('es')));
      }
    }
    body.appendChild(summaryRow('Mensajes de chat', String(sessionChatMsgCount)));
    for (const name of Object.keys(sessionBitrateSum)) {
      const avg = Math.round(sessionBitrateSum[name] / sessionBitrateCount[name]);
      body.appendChild(summaryRow('Bitrate prom. ' + name, avg + ' kbps'));
    }
    $('#summaryOverlay').classList.add('open');
  }

  // ── Historial de sesiones (Fase 6, docs/PLAN_FEATURES_LOTE2.md) ──────────────────────
  // A diferencia del resumen de arriba (sessionPeakViewers y demás, todo en memoria del
  // cliente, se pierde al cerrar la ventana), esto persiste server-side en sessions.json
  // — ver src/sessions.js / src/routes/sessions.js. Preferencias → Historial, se carga
  // bajo demanda (openPrefs), no hace falta pollearlo.
  function fmtSessionDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(UI_LANG, { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString(UI_LANG, { hour: '2-digit', minute: '2-digit' });
  }
  async function loadSessionHistory() {
    const box = $('#sessionHistoryList');
    if (!box) return;
    try {
      const { sessions } = await api('GET', '/api/sessions');
      renderSessionHistory(sessions);
    } catch {
      box.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'preset-chips-empty';
      err.textContent = 'No se pudo cargar el historial.';
      box.appendChild(err);
    }
  }
  function renderSessionHistory(sessions) {
    const box = $('#sessionHistoryList');
    box.innerHTML = '';
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'preset-chips-empty';
      empty.textContent = 'Todavía no hay sesiones registradas — se guardan solas cada vez que sales en vivo de verdad (al menos una plataforma conectada).';
      box.appendChild(empty);
      return;
    }
    const table = document.createElement('table');
    table.className = 'history-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Fecha', 'Duración', 'Plataformas', 'Pico de espectadores']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const s of sessions) {
      const tr = document.createElement('tr');
      const tdDate = document.createElement('td');
      tdDate.textContent = fmtSessionDate(s.startedAt);
      const tdDur = document.createElement('td');
      tdDur.textContent = fmtUptime(s.durationSeconds);
      const tdDest = document.createElement('td');
      tdDest.textContent = s.destinations.length ? s.destinations.join(', ') : '—';
      const tdPeak = document.createElement('td');
      const peakEntries = Object.entries(s.peakViewers || {}).filter(([, v]) => v > 0);
      tdPeak.textContent = peakEntries.length
        ? peakEntries.map(([p, v]) => (VIEWER_PLATFORM_LABELS[p] || p) + ' ' + v.toLocaleString(UI_LANG)).join(', ')
        : '—';
      tr.append(tdDate, tdDur, tdDest, tdPeak);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
  }

  // ── Comprobación previa a salir en vivo ──
  // Valores de referencia ampliamente citados para cada plataforma — no se leen en vivo
  // de su documentación (no existe un endpoint para eso). Si alguna cambia su límite
  // recomendado, actualizar acá a mano.
  const PLATFORM_BITRATE_MAX = { twitch: 6000, kick: 8000, tiktok: 6000, youtube: 51000 };
  function preflightRow(status, label) {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '.5rem';
    const dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex-shrink:0';
    dot.style.background = status === true ? 'var(--live)' : status === false ? 'var(--warn)' : 'var(--muted)';
    const text = document.createElement('span');
    text.textContent = label;
    row.appendChild(dot);
    row.appendChild(text);
    return row;
  }
  function closePreflight() { $('#preflightOverlay').classList.remove('open'); }
  async function openPreflightCheck() {
    const body = $('#preflightBody');
    body.innerHTML = '';
    const state = lastState;
    if (!state || !state.live) {
      body.appendChild(preflightRow(null, 'Conecta tu software de streaming para revisar audio y bitrate.'));
    } else {
      const hasAudio = vu.tL > 1 || vu.tR > 1;
      body.appendChild(preflightRow(hasAudio, hasAudio
        ? 'Señal de audio detectada.'
        : 'Sin señal de audio — revisa el mic en tu software de streaming.'));

      const liveDest = state.destinations.find((d) => d.status === 'live' && d.metrics && d.metrics.bitrate);
      if (liveDest) {
        const bitrate = liveDest.metrics.bitrate;
        const enabledIds = state.destinations.filter((d) => d.enabled && d.url).map((d) => d.name.toLowerCase());
        const caps = enabledIds.map((id) => PLATFORM_BITRATE_MAX[id]).filter(Boolean);
        const tightestCap = caps.length ? Math.min(...caps) : null;
        if (tightestCap) {
          const withinCap = bitrate <= tightestCap;
          body.appendChild(preflightRow(withinCap, withinCap
            ? ('Bitrate ' + bitrate + ' kbps dentro de lo recomendado.')
            : ('Bitrate ' + bitrate + ' kbps supera lo recomendado (~' + tightestCap + ' kbps) para alguno de tus destinos.')));
        }
      } else {
        body.appendChild(preflightRow(null, 'Bitrate: esperando datos de algún destino activo.'));
      }
    }

    if (window.msOAuth?.checkLiveTokens) {
      try {
        const tokens = await window.msOAuth.checkLiveTokens();
        const entries = Object.entries(tokens);
        if (!entries.length) {
          body.appendChild(preflightRow(null, 'No hay cuentas conectadas por OAuth.'));
        } else {
          for (const [platform, ok] of entries) {
            body.appendChild(preflightRow(ok, ok
              ? ('Sesión de ' + platform + ' activa.')
              : ('Sesión de ' + platform + ' vencida — reconéctala en el panel.')));
          }
        }
      } catch {
        body.appendChild(preflightRow(null, 'No se pudo comprobar el estado de las cuentas conectadas.'));
      }
    }

    $('#preflightOverlay').classList.add('open');
  }

  // ── Programar inicio ──
  // Cada destino tiene su propia hora, independiente de los demás (ej. Kick a las 12:08,
  // Twitch a otra hora) — name -> { atMs, timerId }. Solo vive en esta sesión del panel
  // (setTimeout en el navegador) — no persiste si cierras la app entera antes de que
  // llegue la hora.
  const scheduledEntries = {};

  function toLocalInputValue(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtScheduledTime(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function closeScheduleModal() { $('#scheduleOverlay').classList.remove('open'); }

  function openScheduleModal() {
    const list = $('#scheduleDestList');
    list.innerHTML = '';
    const state = lastState;
    const dests = (state?.destinations || []).filter((d) => d.url);
    if (!dests.length) {
      list.appendChild(preflightRow(null, 'No hay destinos con URL configurada todavía.'));
    } else {
      for (const d of dests) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-direction:column;gap:.3rem';
        const head = document.createElement('label');
        head.style.cssText = 'display:flex;align-items:center;gap:.5rem;font-size:.85rem;cursor:pointer';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.name = d.name;
        cb.checked = !!scheduledEntries[d.name] || !d.enabled; // por defecto marca los que hoy están apagados
        head.appendChild(cb);
        head.appendChild(document.createTextNode(d.name));
        row.appendChild(head);
        const timeInput = document.createElement('input');
        timeInput.type = 'datetime-local';
        timeInput.dataset.name = d.name;
        if (scheduledEntries[d.name]) timeInput.value = toLocalInputValue(scheduledEntries[d.name].atMs);
        row.appendChild(timeInput);
        list.appendChild(row);
      }
    }
    $('#scheduleOverlay').classList.add('open');
  }

  function scheduleFor(name, atMs) {
    if (scheduledEntries[name]) clearTimeout(scheduledEntries[name].timerId);
    const timerId = setTimeout(() => runScheduledStart(name), atMs - Date.now());
    scheduledEntries[name] = { atMs, timerId };
  }
  function cancelScheduleFor(name) {
    if (!scheduledEntries[name]) return;
    clearTimeout(scheduledEntries[name].timerId);
    delete scheduledEntries[name];
  }

  async function runScheduledStart(name) {
    delete scheduledEntries[name];
    const state = lastState;
    const d = state?.destinations.find((x) => x.name === name);
    if (!d) return;
    try { await api('POST', '/api/destinations', { name: d.name, url: d.url, enabled: true, maxBitrate: d.maxBitrate }); } catch {}
    toast(name + ' activado (programado)');
    refresh();
  }

  function confirmSchedule() {
    const names = [...document.querySelectorAll('#scheduleDestList [data-name]')].map((el) => el.dataset.name);
    const uniqueNames = [...new Set(names)];
    let changed = 0;
    for (const name of uniqueNames) {
      const cb = document.querySelector('#scheduleDestList input[type=checkbox][data-name="' + name.replace(/"/g, '') + '"]');
      const timeInput = document.querySelector('#scheduleDestList input[type=datetime-local][data-name="' + name.replace(/"/g, '') + '"]');
      if (!cb || !timeInput) continue;
      if (!cb.checked) { cancelScheduleFor(name); continue; }
      const atMs = new Date(timeInput.value).getTime();
      if (!timeInput.value || Number.isNaN(atMs) || atMs <= Date.now()) continue; // sin hora válida, no lo toca
      scheduleFor(name, atMs);
      changed++;
    }
    toast(changed ? 'Programación guardada' : 'Sin cambios — revisa que las horas marcadas sean futuras');
    closeScheduleModal();
  }

  function showUpdaterProgress(percent, speedText) {
    $('#updaterButtons').style.display = 'none';
    const progBox = $('#updaterProgressBox');
    progBox.style.display = '';
    $('#updaterProgressFill').style.width = Math.max(0, Math.min(100, percent)) + '%';
    $('#updaterProgressText').textContent = Math.round(percent) + '%' + (speedText ? ' · ' + speedText : '');
  }
  function toggleUpdaterNotes() {
    $('#updaterNotesBlock').classList.toggle('open');
  }

  function handleUpdaterEvent(payload) {
    const { type, title, message, detail, percent, bytesPerSecond, releaseNotes } = payload || {};
    if (type === 'progress') {
      // Solo actualiza la barra — no toca título/mensaje ya mostrados por el evento 'available'.
      showUpdaterProgress(percent, fmtMBs(bytesPerSecond));
      $('#updaterOverlay').classList.add('open');
      return;
    }
    $('#updaterTitle').textContent = title || 'Muxlyve';
    $('#updaterMessage').textContent = message || '';
    $('#updaterDetail').textContent = detail || '';
    $('#updaterDetail').style.display = detail ? '' : 'none';
    const notesBlock = $('#updaterNotesBlock');
    if (type === 'available' && releaseNotes) {
      $('#updaterNotesText').textContent = releaseNotes;
      notesBlock.classList.remove('open'); // colapsado por defecto, no invasivo
      notesBlock.style.display = '';
    } else {
      notesBlock.style.display = 'none';
    }
    $('#updaterProgressBox').style.display = 'none';
    const box = $('#updaterButtons');
    box.style.display = 'flex';
    box.innerHTML = '';
    if (type === 'available') {
      // En Mac el auto-update no aplica sin firma Developer ID real (Squirrel.Mac
      // rechaza el paquete en silencio) — mientras no haya certificado, solo se ofrece
      // el dmg manual. Ver electron/updater.js.
      const isMac = document.body.classList.contains('platform-darwin');
      if (!isMac) {
        box.appendChild(updaterBtn(pick({ es: 'Descargar', en: 'Download', fr: 'Télécharger', pt: 'Baixar' }), true, () => {
          pendingUpdatePayload = null; // ya en curso — que no vuelva el ícono al cerrar
          showUpdaterProgress(0, pick({ es: 'Iniciando…', en: 'Starting…', fr: 'Démarrage…', pt: 'Iniciando…' }));
          window.msApp.downloadUpdate();
        }));
      }
      box.appendChild(updaterBtn(pick({ es: 'Descargar desde la web', en: 'Download from the web', fr: 'Télécharger depuis le web', pt: 'Baixar da web' }), isMac, async () => {
        await window.msApp.openUpdateWeb();
        closeUpdaterModal();
      }));
      box.appendChild(updaterBtn(pick({ es: 'Ahora no', en: 'Not now', fr: 'Pas maintenant', pt: 'Agora não' }), false, closeUpdaterModal));
    } else if (type === 'downloaded') {
      box.appendChild(updaterBtn(pick({ es: 'Reiniciar ahora', en: 'Restart now', fr: 'Redémarrer maintenant', pt: 'Reiniciar agora' }), true, () => window.msApp.installUpdate()));
      box.appendChild(updaterBtn(pick({ es: 'Después', en: 'Later', fr: 'Plus tard', pt: 'Depois' }), false, closeUpdaterModal));
    } else if (type === 'error') {
      box.appendChild(updaterBtn(pick({ es: 'Descargar desde la web', en: 'Download from the web', fr: 'Télécharger depuis le web', pt: 'Baixar da web' }), true, async () => {
        await window.msApp.openUpdateWeb();
        closeUpdaterModal();
      }));
      box.appendChild(updaterBtn(pick({ es: 'Cerrar', en: 'Close', fr: 'Fermer', pt: 'Fechar' }), false, closeUpdaterModal));
    } else {
      box.appendChild(updaterBtn('OK', true, closeUpdaterModal));
    }
    $('#updaterOverlay').classList.add('open');
  }
  function routeUpdaterEvent(payload) {
    if (payload && payload.type === 'available') {
      pendingUpdatePayload = payload;
      $('#updateBtn').style.display = 'flex';
      return;
    }
    handleUpdaterEvent(payload);
  }
  if (window.msApp?.onUpdaterEvent) window.msApp.onUpdaterEvent(routeUpdaterEvent);

  function openStreamInfo() { $('#streamInfoOverlay').classList.add('open'); }
  function closeStreamInfo() { $('#streamInfoOverlay').classList.remove('open'); }
  function updateStreamTitleDisplay() {
    const title = localStorage.getItem('ms_stream_title') || '';
    const el = $('#streamTitleDisplay');
    el.textContent = title;
    el.style.display = title ? '' : 'none';
    el.title = title;
  }

  // Reemplaza confirm() nativo — resolveConfirmFn guarda el resolve de la promesa
  // pendiente mientras el modal está abierto.
  let resolveConfirmFn = null;
  function showConfirm(message, okText, title) {
    $('#confirmTitle').textContent = title || 'Confirmar';
    $('#confirmMessage').textContent = message;
    $('#confirmOkBtn').textContent = okText || 'Confirmar';
    $('#confirmOverlay').classList.add('open');
    return new Promise((resolve) => { resolveConfirmFn = resolve; });
  }
  function resolveConfirm(value) {
    $('#confirmOverlay').classList.remove('open');
    if (resolveConfirmFn) { resolveConfirmFn(value); resolveConfirmFn = null; }
  }

  // Reemplaza prompt() nativo — mismo motivo/patrón que showConfirm de arriba. Devuelve
  // el texto (recortado) o null si canceló / lo dejó vacío.
  let resolvePromptFn = null;
  function showPrompt(title, placeholder) {
    $('#promptTitle').textContent = title || 'Confirmar';
    $('#promptInput').value = '';
    $('#promptInput').placeholder = placeholder || '';
    $('#promptOverlay').classList.add('open');
    setTimeout(() => $('#promptInput').focus(), 50);
    return new Promise((resolve) => { resolvePromptFn = resolve; });
  }
  function resolvePrompt(value) {
    $('#promptOverlay').classList.remove('open');
    if (resolvePromptFn) { resolvePromptFn(value && value.trim() ? value.trim() : null); resolvePromptFn = null; }
  }

  async function releaseLic() {
    const ok = await showConfirm(
      '¿Liberar este equipo? La app se cerrará y necesitarás tu clave para volver a activarla.',
      'Liberar equipo',
    );
    if (!ok) return;
    await window.msLicense?.release();
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePrefs(); closeAbout(); closeReport(); closeFeedback(); } });

  // Pestañas del sidebar: Conexiones y Chat son mutuamente excluyentes. Click en la
  // pestaña activa colapsa todo el sidebar (mismo gesto que el botón único de antes).
  let activeSidebarTab = null;
  function showSidebarTab(tab) {
    const col = $('#sidebarCol');
    const isOpen = !col.classList.contains('collapsed');
    if (isOpen && activeSidebarTab === tab) {
      col.classList.add('collapsed');
      activeSidebarTab = null;
    } else {
      activeSidebarTab = tab;
      col.classList.remove('collapsed');
      $('#connPanel').style.display = tab === 'conn' ? '' : 'none';
      $('#chatPanel').style.display = tab === 'chat' ? '' : 'none';
      $('#rtmpPanel').style.display = tab === 'rtmp' ? '' : 'none';
    }
    $('#connBtn').classList.toggle('panel-open', activeSidebarTab === 'conn');
    $('#chatBtn').classList.toggle('panel-open', activeSidebarTab === 'chat');
    $('#rtmpBtn').classList.toggle('panel-open', activeSidebarTab === 'rtmp');
  }

  function openChatWindow() {
    if (window.msApp && window.msApp.openChatWindow) {
      window.msApp.openChatWindow(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    } else {
      toast('Solo disponible en la app de escritorio', true);
    }
  }

  // ── Cuentas OAuth (solo Electron) ──
  async function loadAuthStatus() {
    if (!window.msOAuth) return;
    try {
      lastAuthStatus = await window.msOAuth.status();
      renderPlatforms();
    } catch {}
  }

  async function connectPlatform(platform) {
    if (platform === 'youtube' && YOUTUBE_OAUTH_PENDING && window._isPackaged) {
      toast('YouTube: esta funcionalidad estará disponible en una próxima versión (en espera de aprobación de Google).', true);
      return;
    }
    const btn = $('#pb-' + platform + ' .auth-conn');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
      const r = await window.msOAuth.connect(platform);
      if (r.ok) {
        const label = (AUTH_PLATFORMS.find(p => p.id === platform) || {}).name || platform;
        toast('✓ ' + label + ' conectado' + (r.username ? ' (' + r.username + ')' : ''));
        // Trae la clave de stream lista (p.ej. Twitch) — evita que el usuario tenga que
        // ir a buscarla y pegarla a mano tras conectar.
        if (r.rtmpUrl) {
          try { render(await api('POST', '/api/destinations', { name: label, url: r.rtmpUrl, enabled: false })); }
          catch { /* el destino se puede añadir a mano si esto falla */ }
        }
      } else { toast(r.error || 'Error al conectar', true); }
    } catch (e) { toast(e.message, true); }
    loadAuthStatus();
  }

  async function disconnectPlatform(platform) {
    try { await window.msOAuth.disconnect(platform); } catch {}
    loadAuthStatus();
  }

  // ── Chat unificado (fase 1: Twitch) ──
  // renderMessageBody() vive en /chat-render.js (compartida, ver comentario arriba).

  // Filtro de palabras — mini auto-mod client-side: oculta mensajes por keyword sin
  // depender de la API de cada plataforma (Kick no expone modo lento/solo-emotes por API,
  // esto sí funciona igual en Twitch y Kick porque corre acá, no allá).
  function loadChatKeywords() {
    try { chatKeywords = JSON.parse(localStorage.getItem('ms_chat_keywords') || '[]'); } catch { chatKeywords = []; }
    const input = $('#chatKeywordFilterInput');
    if (input) input.value = chatKeywords.join(', ');
  }
  function applyChatKeywordFilter() {
    const raw = $('#chatKeywordFilterInput').value;
    chatKeywords = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    localStorage.setItem('ms_chat_keywords', JSON.stringify(chatKeywords));
    toast('Filtro de palabras actualizado');
  }
  function isChatMessageBlocked(text) {
    if (!chatKeywords.length || !text) return false;
    const low = text.toLowerCase();
    return chatKeywords.some((k) => low.includes(k));
  }

  function appendChatMessage(msg) {
    if (isChatMessageBlocked(msg.message)) return;
    const box = $('#chatMessages');
    if (!box) return;
    const empty = box.querySelector('.chat-empty');
    if (empty) empty.remove();
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    const row = document.createElement('div');
    row.className = 'chat-row';
    const iconHtml = platformIconSvg(msg.platform, 14);
    if (iconHtml) {
      const iconWrap = document.createElement('span');
      iconWrap.className = 'chat-icon';
      iconWrap.innerHTML = iconHtml; // SVG generado por nosotros — no viene del chat externo
      row.appendChild(iconWrap);
    }
    if (msg.isBroadcaster) {
      const badge = document.createElement('span');
      badge.className = 'chat-icon';
      badge.title = 'Tú (streamer)';
      badge.innerHTML = BROADCASTER_BADGE_SVG;
      row.appendChild(badge);
    }
    const textWrap = document.createElement('span');
    const nameEl = document.createElement('strong');
    nameEl.style.color = msg.color || '#9147ff';
    nameEl.textContent = msg.username || '???';
    textWrap.appendChild(nameEl);
    textWrap.appendChild(document.createTextNode(': '));
    renderMessageBody(textWrap, msg.message || '', msg.emotes);
    row.appendChild(textWrap);
    // Fijar: solo Twitch tiene API pública real para esto — Kick lo tiene en su dashboard
    // pero es un endpoint interno no expuesto a apps de terceros; YouTube no lo tiene.
    if (msg.platform === 'twitch' && msg.id) {
      const pinBtn = document.createElement('button');
      pinBtn.className = 'chat-pin-btn';
      pinBtn.dataset.messageId = msg.id;
      updatePinBtnState(pinBtn, msg.id === pinnedMessageId);
      pinBtn.onclick = () => pinChatMessageUi(pinBtn, msg.id);
      row.appendChild(pinBtn);
    }
    // Moderar (timeout/ban): solo Twitch, y no sobre tu propio mensaje.
    if (msg.platform === 'twitch' && msg.userId && !msg.isBroadcaster) {
      row.appendChild(createModBtn(msg.userId));
    }
    box.appendChild(row);
    while (box.children.length > 200) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  // pinnedMessageId/updatePinBtnState/pinChatMessageUi/syncPinnedMessage viven en
  // /chat-render.js (compartida con el popout, ver comentario al principio del archivo).
  function connectChatStream() {
    if (!window.EventSource) return;
    const box = $('#chatMessages');
    if (box) box.innerHTML = '<div class="chat-empty">Esperando mensajes…</div>';
    syncPinnedMessage();
    const es = new EventSource('/api/chat');
    es.onmessage = (e) => {
      try {
        sessionChatMsgCount++; // cuenta todo lo recibido, filtrado o no (ver isChatMessageBlocked)
        appendChatMessage(JSON.parse(e.data));
      } catch {}
    };
  }

  function renderViewerBar(counts) {
    const bar = $('#viewerBar');
    if (!bar) return;
    bar.innerHTML = '';
    let any = false;
    for (const p of ['twitch', 'kick', 'youtube']) {
      const v = counts[p];
      if (!v || !v.live) continue;
      any = true;
      if (v.count > (sessionPeakViewers[p] || 0)) sessionPeakViewers[p] = v.count;
      const item = document.createElement('span');
      item.className = 'vb-item';
      item.innerHTML = platformIconSvg(p, 12);
      item.appendChild(document.createTextNode(v.count.toLocaleString('es')));
      bar.appendChild(item);
    }
    bar.style.display = any ? 'flex' : 'none';
  }
  async function pollViewers() {
    try { renderViewerBar(await api('GET', '/api/viewers')); } catch {}
  }

  if (window.msApp) { window.msApp.isPackaged().then(v => { window._isPackaged = v; }).catch(() => {}); }

  updateMonBtn(); // pinta el ícono de audio inicial (mudo) — ver togglePreviewAudio()
  loadConfig();
  refresh();
  loadAuthStatus();
  loadPresets();
  showSidebarTab('chat'); // arranca siempre mostrando el chat
  connectChatStream();
  pollViewers();
  setInterval(refresh, 2000); // refleja estado en vivo y reenvíos activos
  setInterval(pollViewers, 20000); // el backend sondea Twitch/Kick/YouTube cada 30s, no hace falta más seguido
