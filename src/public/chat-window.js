const ua = navigator.userAgent;
if (ua.includes('Mac')) document.body.classList.add('platform-darwin');
else if (ua.includes('Windows')) document.body.classList.add('platform-win32');
else if (ua.includes('Linux')) document.body.classList.add('platform-linux');

function toggleChatMenu(e) {
  e.stopPropagation();
  document.getElementById('chatMenuDd').classList.toggle('open');
}
function toggleOverlayInfo(e) {
  e.stopPropagation();
  document.getElementById('overlayInfoDd').classList.toggle('open');
}
document.addEventListener('click', () => {
  const dd = document.getElementById('chatMenuDd');
  if (dd) dd.classList.remove('open');
  const infoDd = document.getElementById('overlayInfoDd');
  if (infoDd) infoDd.classList.remove('open');
});
function applyChatMode(btn) {
  const emoteOnly = document.getElementById('emoteOnlyChk').checked;
  const subscriberOnly = document.getElementById('subOnlyChk').checked;
  const slowOn = document.getElementById('slowModeChk').checked;
  const slowSeconds = slowOn ? Math.max(1, Number(document.getElementById('slowSecondsInput').value) || 30) : 0;
  const status = document.getElementById('chatModeStatus');
  btn.disabled = true;
  if (status) { status.textContent = 'Aplicando…'; status.style.color = ''; }
  fetch('/api/chat-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoteOnly, subscriberOnly, slowSeconds }),
  }).then((r) => r.json()).then((r) => {
    btn.disabled = false;
    if (!status) return;
    if (r && r.ok) { status.textContent = 'Aplicado ✓'; status.style.color = '#3fb950'; }
    else { status.textContent = (r && r.error) || 'No se pudo aplicar — ¿Twitch conectado?'; status.style.color = '#f85149'; }
  }).catch(() => {
    btn.disabled = false;
    if (status) { status.textContent = 'Error de conexión.'; status.style.color = '#f85149'; }
  });
}

function sendChatMessageUi(btn) {
  const input = document.getElementById('chatSendInput');
  const status = document.getElementById('chatSendStatus');
  const text = input.value.trim();
  if (!text) return;
  btn.disabled = true;
  fetch('/api/chat-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).then((r) => r.json()).then((results) => {
    btn.disabled = false;
    const entries = Object.keys(results || {});
    if (!entries.length) {
      if (status) { status.textContent = 'Conecta Twitch o Kick primero.'; status.style.color = '#f85149'; }
      return;
    }
    const failed = entries.filter((p) => !results[p].ok);
    if (!failed.length) {
      input.value = '';
      if (status) { status.textContent = ''; }
    } else if (status) {
      status.textContent = 'Falló en ' + failed.join(', ');
      status.style.color = '#f85149';
    }
  }).catch(() => {
    btn.disabled = false;
    if (status) { status.textContent = 'Error de conexión.'; status.style.color = '#f85149'; }
  });
}
document.getElementById('chatSendInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatMessageUi(document.querySelector('#chatSendRow button'));
});

// Tema inicial: viene por query string al abrir la ventana. Se mantiene sincronizado
// en vivo con la app principal vía BroadcastChannel (mismo origen http://localhost).
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : '';
try {
  const themeChannel = new BroadcastChannel('muxlyve-theme');
  themeChannel.onmessage = (e) => {
    document.documentElement.dataset.theme = e.data === 'light' ? 'light' : '';
  };
} catch (err) {}

(() => {
  const field = document.getElementById('stars');
  const n = 50;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    const size = (Math.random() * 1.6 + .6).toFixed(1);
    s.style.width = size + 'px';
    s.style.height = size + 'px';
    s.style.left = (Math.random() * 100) + '%';
    s.style.top = (Math.random() * 100) + '%';
    s.style.animationDelay = (Math.random() * 3.5).toFixed(2) + 's';
    field.appendChild(s);
  }
})();

// PLATFORM_ICON_GLYPHS/COLORS, platformIconSvg, BROADCASTER_BADGE_SVG, PIN_ICON_SVG,
// renderMessageBody, y la lógica de fijar/desfijar viven en /chat-render.js —
// compartida con el panel principal, se carga antes que este script.

function append(msg) {
  const box = document.getElementById('box');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  const row = document.createElement('div');
  row.className = 'row';
  const iconHtml = platformIconSvg(msg.platform, 14, 4);
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
  textWrap.className = 'chat-msg-body';
  textWrap.dataset.msgId = msg.id; // ver applyTranslation() en chat-render.js
  const strong = document.createElement('strong');
  strong.style.color = msg.color || '#9147ff';
  strong.textContent = msg.username || '???';
  textWrap.appendChild(strong);
  renderMessageBody(textWrap, msg.message || '', msg.emotes);
  row.appendChild(textWrap);
  if (msg.platform === 'twitch' && msg.id) {
    const pinBtn = document.createElement('button');
    pinBtn.className = 'chat-pin-btn';
    pinBtn.dataset.messageId = msg.id;
    updatePinBtnState(pinBtn, msg.id === pinnedMessageId); // ya deja el ícono cargado
    pinBtn.onclick = () => pinChatMessageUi(pinBtn, msg.id);
    row.appendChild(pinBtn);
  }
  // Moderar (timeout/ban): solo Twitch, y no sobre tu propio mensaje.
  if (msg.platform === 'twitch' && msg.userId && !msg.isBroadcaster) {
    row.appendChild(createModBtn(msg.userId));
  }
  box.appendChild(row);
  while (box.children.length > 300) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}
syncPinnedMessage();
const es = new EventSource('/api/chat');
es.onmessage = (e) => {
  try {
    const data = JSON.parse(e.data);
    if (data.type === 'translation') { applyTranslation(data.id, data.translated); return; }
    append(data);
  } catch (err) { console.error('[chat-window] no se pudo mostrar el mensaje:', err); }
};

function renderViewerBar(counts) {
  const bar = document.getElementById('viewerBar');
  if (!bar) return;
  bar.innerHTML = '';
  let any = false;
  ['twitch', 'kick', 'youtube'].forEach((p) => {
    const v = counts[p];
    if (!v || !v.live) return;
    any = true;
    const item = document.createElement('span');
    item.className = 'vb-item';
    item.innerHTML = platformIconSvg(p, 14, 4);
    item.appendChild(document.createTextNode(v.count.toLocaleString('es')));
    bar.appendChild(item);
  });
  bar.style.display = any ? 'flex' : 'none';
}
function pollViewers() {
  fetch('/api/viewers').then((r) => r.json()).then(renderViewerBar).catch(() => {});
}
pollViewers();
setInterval(pollViewers, 20000);
