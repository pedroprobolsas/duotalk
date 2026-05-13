/**
 * ui.js — Capa de presentación pura.
 * No contiene lógica de negocio ni comunicación de red.
 */

// ── Navegación entre pantallas ────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(`screen-${name}`);
  if (target) target.classList.add('active');
}

// ── Renderizar selector de idiomas ───────────────────────────────────────
function renderLangPicker(containerId, selectedCode, disabledCode, onSelect) {
  const container = document.getElementById(containerId);
  const wrapper = container.querySelector('.lang-options') || (() => {
    const div = document.createElement('div');
    div.className = 'lang-options';
    container.appendChild(div);
    return div;
  })();

  wrapper.innerHTML = '';

  LANGUAGES.forEach(lang => {
    const el = document.createElement('button');
    el.className = 'lang-option';
    el.dataset.code = lang.code;
    el.innerHTML = `<span class="lang-flag">${lang.flag}</span><span>${lang.name}</span>`;

    if (lang.code === selectedCode) el.classList.add('selected');
    if (lang.code === disabledCode) el.classList.add('disabled');

    el.addEventListener('click', () => onSelect(lang.code));
    wrapper.appendChild(el);
  });
}

// ── QR Code ───────────────────────────────────────────────────────────────
function renderQR(url) {
  const container = document.getElementById('qr-code');
  container.innerHTML = '';
  new QRCode(container, {
    text: url,
    width: 220,
    height: 220,
    colorDark: '#000',
    colorLight: '#fff',
    correctLevel: QRCode.CorrectLevel.M,
  });
}

// ── Mostrar código de sala ────────────────────────────────────────────────
function displayRoomCode(code) {
  document.getElementById('room-code-display').textContent = code;
}

// ── Agregar burbuja de conversación ──────────────────────────────────────
function addBubble({ role, originalText, translatedText, originalLang, targetLang }) {
  const list = document.getElementById('bubble-list');

  // Límite de 50 burbujas en pantalla (doc: sección 4.3)
  const bubbles = list.querySelectorAll('.bubble');
  if (bubbles.length >= 50) bubbles[0].remove();

  const bubble = document.createElement('div');
  bubble.className = `bubble ${role}`;
  bubble.innerHTML = `
    <span class="bubble-role">${role === 'host' ? '📱 Tú' : '👤 Invitado'}</span>
    <div class="bubble-original">${escapeHtml(originalText)}</div>
    <div class="bubble-translation">${escapeHtml(translatedText)}</div>
  `;

  list.appendChild(bubble);
  list.scrollTop = list.scrollHeight;
}

// ── Indicadores de turno ──────────────────────────────────────────────────
function showTurnBlocked(activeRole) {
  const el = document.getElementById('turn-indicator');
  document.getElementById('turn-text').textContent =
    activeRole === 'host' ? 'El anfitrión está hablando…' : 'El invitado está hablando…';
  el.classList.remove('hidden');
}

function hideTurnBlocked() {
  document.getElementById('turn-indicator').classList.add('hidden');
}

function showProcessing() {
  document.getElementById('processing-indicator').classList.remove('hidden');
}

function hideProcessing() {
  document.getElementById('processing-indicator').classList.add('hidden');
}

// ── Sesión: timer y cabecera ──────────────────────────────────────────────
let _sessionInterval = null;

function startSessionTimer() {
  let seconds = 0;
  _sessionInterval = setInterval(() => {
    seconds++;
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    document.getElementById('session-timer').textContent = `${m}:${s}`;
  }, 1000);
}

function stopSessionTimer() {
  clearInterval(_sessionInterval);
}

function setSessionLangs(hostLang, guestLang) {
  const host  = LANGUAGES.find(l => l.code === hostLang)?.name  || hostLang;
  const guest = LANGUAGES.find(l => l.code === guestLang)?.name || guestLang;
  document.getElementById('session-langs').textContent = `${host} ↔ ${guest}`;
}

// ── Modales ───────────────────────────────────────────────────────────────
function showErrorModal(title, message) {
  document.getElementById('modal-error-title').textContent = title;
  document.getElementById('modal-error-msg').textContent = message;
  document.getElementById('modal-error').classList.remove('hidden');
}

function hideErrorModal() {
  document.getElementById('modal-error').classList.add('hidden');
}

function showSuspendedModal(disconnectedRole, resumeDeadline) {
  const role = disconnectedRole === 'host' ? 'El anfitrión' : 'El invitado';
  document.getElementById('modal-suspended-msg').textContent =
    `${role} se desconectó. Esperando reconexión…`;

  document.getElementById('modal-suspended').classList.remove('hidden');
  startCountdown(resumeDeadline);
}

function hideSuspendedModal() {
  document.getElementById('modal-suspended').classList.add('hidden');
}

function startCountdown(deadlineMs) {
  const fill = document.getElementById('countdown-fill');
  const text = document.getElementById('countdown-text');
  const total = deadlineMs - Date.now();

  const update = () => {
    const remaining = Math.max(0, deadlineMs - Date.now());
    const pct = (remaining / total) * 100;
    fill.style.width = `${pct}%`;
    text.textContent = `${Math.ceil(remaining / 1000)} segundos`;
    if (remaining > 0) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

// ── Mensajes de error inline ──────────────────────────────────────────────
function showInlineError(elementId, message) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideInlineError(elementId) {
  document.getElementById(elementId).classList.add('hidden');
}

// ── Utilidad ──────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
