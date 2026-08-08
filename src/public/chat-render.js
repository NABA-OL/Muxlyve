// Propiedad de BlacKraken Solutions
// Desarrollado por NABA-OL
// Lógica de chat compartida entre las 3 vistas (panel principal, popout de chat, overlay
// de OBS) — antes vivía triplicada (una copia por vista), un fix en una se olvidaba en
// las otras. Ver Fase 2 de docs/PLAN_REFACTOR_PANEL.md.
//
// Sin type="module" (mismo motivo que panel-client.js/chat-window.js — ver Trampa 1 del
// plan): se carga con <script src="/chat-render.js"> ANTES del script propio de cada
// vista, así estas funciones quedan como globales que ese script usa directo.
//
// Esto NO asume que exista `toast()` ni `window.msApp` — el overlay y el popout no los
// tienen (solo el panel principal). Ver el comentario de pinChatMessageUi más abajo.

const PLATFORM_ICON_GLYPHS = {
  twitch: '<path fill="#fff" d="M5 3 3 6.5v12H7V21l3-2.5h3l5.5-5V3H5zm10 9-3 3h-3l-2.5 2.5V15H5V5h13v7z"/><path fill="#fff" d="M14.5 7h1.8v4h-1.8zM10.3 7h1.8v4h-1.8z"/>',
  youtube: '<path fill="#fff" d="M21 8s-.2-1.4-.8-2c-.7-.8-1.5-.8-1.9-.9C15.9 5 12 5 12 5s-3.9 0-6.3.1c-.4.1-1.2.1-1.9.9C3.2 6.6 3 8 3 8s-.2 1.6-.2 3.2v1.2c0 1.6.2 3.2.2 3.2s.2 1.4.8 2c.7.8 1.7.7 2.1.8C7.5 18.6 12 18.6 12 18.6s3.9 0 6.3-.2c.4 0 1.2-.1 1.9-.8.6-.6.8-2 .8-2s.2-1.6.2-3.2v-1.2C21.2 9.6 21 8 21 8zM9.9 14.2V9l5.4 2.6z"/>',
  kick: '<path fill="#0a0a0a" d="M4 4h4v4.2L11.8 4H16l-5.4 6L16 16h-4.2L8 11.8V16H4z"/>',
  tiktok: '<path fill="#fff" d="M15.5 3h-3v11.6a2.4 2.4 0 1 1-1.7-2.3v-3.1a5.5 5.5 0 1 0 4.7 5.4V9.1c1 .7 2.2 1.1 3.5 1.1V7.2c-1.9 0-3.5-1.6-3.5-3.6z"/>',
};
const PLATFORM_ICON_COLORS = { twitch: '#9147ff', youtube: '#ff0000', kick: '#53fc18', tiktok: '#010101' };

// size/radius parametrizables — el panel principal usa 18px/radio 6 por defecto (varios
// tamaños según el lugar, ver sus llamadas); el popout y el overlay SIEMPRE pasan 14/4
// explícito para no cambiar su tamaño actual al deduplicar esto.
function platformIconSvg(id, size, radius) {
  const glyph = PLATFORM_ICON_GLYPHS[id];
  if (!glyph) return '';
  const s = size || 18;
  const r = radius || 6;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" style="flex-shrink:0;border-radius:' + r + 'px">' +
    '<rect width="24" height="24" rx="6" fill="' + PLATFORM_ICON_COLORS[id] + '"/>' + glyph + '</svg>';
}

// Insignia propia (no imitamos el ícono nativo de cada plataforma) para marcar que este
// mensaje lo escribió el streamer — chat.js ya calcula msg.isBroadcaster.
const BROADCASTER_BADGE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="#f0a23a"><path d="M5 18h14l1.3-8-4.8 3-3.5-6-3.5 6-4.8-3z"/></svg>';
const PIN_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>';

// Mismo shape normalizado {start, end, url} que arma chat.js sea Twitch o Kick.
function renderMessageBody(container, text, emotes) {
  if (!emotes || !emotes.length) { container.appendChild(document.createTextNode(text)); return; }
  let cursor = 0;
  for (const e of emotes) {
    if (e.start > cursor) container.appendChild(document.createTextNode(text.slice(cursor, e.start)));
    const img = document.createElement('img');
    img.className = 'chat-emote';
    img.src = e.url;
    img.alt = '';
    container.appendChild(img);
    cursor = e.end;
  }
  if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
}

// El overlay de OBS (CHAT_OVERLAY_HTML) no usa nada de acá para abajo — es de solo
// lectura, sin botón de pin. Vive igual en este módulo compartido en vez de partirlo en
// dos archivos por esto: el overlay lo carga sin usarlo, costo cero relevante (un puñado
// de líneas de más), y el panel principal + el popout sí lo necesitan los dos.
//
// pinChatMessageUi() es un TOGGLE: si el botón que tocaron es el del mensaje YA fijado,
// desfija; si no, fija ese (Twitch reemplaza el anterior solo). `toast()` solo existe en
// el panel principal (PANEL_HTML) — el popout (CHAT_WINDOW_HTML) no lo tiene, por eso se
// llama de forma condicional acá: mismo comportamiento de siempre en cada vista (aviso
// visible en el panel, silencioso en el popout), no una regresión ni una mejora encubierta.
let pinnedMessageId = null;
function updatePinBtnState(btn, isPinned) {
  btn.classList.toggle('pinned', isPinned);
  btn.title = isPinned ? 'Desfijar este mensaje' : 'Fijar este mensaje en Twitch';
  btn.innerHTML = PIN_ICON_SVG;
}
async function pinChatMessageUi(btn, messageId) {
  const wasPinned = messageId === pinnedMessageId;
  btn.disabled = true;
  try {
    const res = await fetch(wasPinned ? '/api/chat-unpin' : '/api/chat-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
    const r = await res.json();
    if (r.ok) {
      // Solo puede haber UN mensaje fijado a la vez en Twitch — si se fijó uno nuevo, el
      // botón del que estaba fijado antes (si sigue visible en la lista) deja de marcarse.
      if (!wasPinned && pinnedMessageId) {
        const prevBtn = document.querySelector('.chat-pin-btn[data-message-id="' + pinnedMessageId + '"]');
        if (prevBtn) updatePinBtnState(prevBtn, false);
      }
      pinnedMessageId = wasPinned ? null : messageId;
      updatePinBtnState(btn, !wasPinned);
      if (typeof toast === 'function') toast(wasPinned ? 'Mensaje desfijado' : 'Mensaje fijado en Twitch');
    } else if (typeof toast === 'function') {
      toast(r.error || (wasPinned ? 'No se pudo desfijar' : 'No se pudo fijar'), true);
    }
  } catch (e) {
    if (typeof toast === 'function') toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}
// Sincroniza con el estado real de Twitch al conectar — si algo quedó fijado de antes
// (ej. la app se reinició, o se fijó/desfijó desde el dashboard de Twitch en vez de
// acá), el próximo botón que se dibuje ya sabe si es el mensaje fijado o no.
async function syncPinnedMessage() {
  try {
    const res = await fetch('/api/chat-pinned');
    const r = await res.json();
    if (r.ok) pinnedMessageId = r.messageId || null;
  } catch {}
}

// ── Timeout/ban (Fase 5, docs/PLAN_FEATURES_LOTE2.md) ───────────────────────────────────
// Solo Twitch — igual que el pin, Kick no lo expone en API pública y YouTube no lo tiene
// en absoluto (ver CLAUDE.md). El overlay de OBS (CHAT_OVERLAY_HTML) no llama a
// createModBtn() en absoluto — es de solo lectura, mismo criterio que el pin.
const MOD_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>';
const MOD_ACTIONS = [
  { label: 'Timeout 1 min', duration: 60 },
  { label: 'Timeout 10 min', duration: 600 },
  { label: 'Timeout 1 hora', duration: 3600 },
  { label: 'Ban permanente', duration: null },
];

function closeAllModMenus() {
  document.querySelectorAll('.chat-mod-menu').forEach((m) => m.remove());
}

async function runModAction(btn, userId, action) {
  closeAllModMenus();
  btn.disabled = true;
  try {
    const res = await fetch('/api/chat-ban', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, duration: action.duration, reason: 'Moderado desde Muxlyve' }),
    });
    const r = await res.json();
    if (typeof toast === 'function') {
      toast(r.ok ? (action.duration ? 'Timeout aplicado' : 'Usuario baneado') : (r.error || 'No se pudo moderar'), !r.ok);
    }
  } catch (e) {
    if (typeof toast === 'function') toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// Menú corto flotante en vez de un modal — timeout 1m/10m/1h o ban permanente. Un solo
// menú abierto a la vez (closeAllModMenus antes de abrir uno nuevo); se cierra solo al
// tocar afuera. Devuelve el botón ya armado, listo para agregar a la fila del mensaje —
// ambas vistas (panel y popout) lo crean igual, ver appendChatMessage()/append().
function createModBtn(userId) {
  const btn = document.createElement('button');
  btn.className = 'chat-mod-btn';
  btn.title = 'Moderar (Twitch)';
  btn.innerHTML = MOD_ICON_SVG;
  btn.onclick = (e) => {
    e.stopPropagation();
    const already = btn.dataset.menuOpen === '1';
    closeAllModMenus();
    if (already) { btn.dataset.menuOpen = ''; return; } // togglea: si ya estaba abierto, solo cerrar
    btn.dataset.menuOpen = '1';
    const menu = document.createElement('div');
    menu.className = 'chat-mod-menu';
    for (const action of MOD_ACTIONS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = action.label;
      item.onclick = (ev) => { ev.stopPropagation(); runModAction(btn, userId, action); };
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    const rect = btn.getBoundingClientRect();
    const menuWidth = 170;
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = Math.max(4, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 4)) + 'px';
    setTimeout(() => {
      document.addEventListener('click', function onDocClick(ev) {
        if (menu.contains(ev.target)) return;
        menu.remove();
        btn.dataset.menuOpen = '';
        document.removeEventListener('click', onDocClick);
      });
    }, 0);
  };
  return btn;
}

// ── Traducción de chat (opt-in, ver chatTranslateEnabled en Preferencias) ──────────────
// La traducción llega por SSE APARTE del mensaje original y un ratito después (ver
// maybeTranslate() en src/chat.js) — para entonces la fila ya está pintada en pantalla.
// Esto solo la busca por su data-msg-id (puesto en appendChatMessage()/append() de cada
// vista, sobre el span que envuelve el texto — nunca el .chat-icon/badge/botones) y le
// agrega una línea aparte debajo. Si el mensaje original ya se podó del historial visible
// (chat muy activo, tope de 40/300 mensajes en pantalla) simplemente no encuentra nada y
// no hace nada — no repinta ni reordena. No vive en el overlay de OBS a propósito: esa
// vista es de solo lectura para el público, la traducción es para que el streamer LEA su
// propio chat, no para el escenario.
function applyTranslation(id, translated) {
  const body = document.querySelector('.chat-msg-body[data-msg-id="' + CSS.escape(String(id)) + '"]');
  if (!body || body.querySelector('.chat-translation')) return;
  const t = document.createElement('span');
  t.className = 'chat-translation';
  t.textContent = translated;
  body.appendChild(t);
}
