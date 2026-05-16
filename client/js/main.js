/**
 * main.js — Orquestador principal.
 * Conecta UI + Socket + estado de la app.
 * Implementa el handler DuoTalk global que escucha los eventos del servidor.
 */

// --- INICIO VISUAL LOG (PARA DEBUG EN IOS) ---
const _originalLog = console.log;
const _originalError = console.error;
const _originalWarn = console.warn;

let visualLogDiv = null;
let logContentDiv = null;

function createVisualLog() {
  if (visualLogDiv) return visualLogDiv;
  
  visualLogDiv = document.createElement('div');
  visualLogDiv.id = 'visual-log-container';
  visualLogDiv.style.position = 'fixed';
  visualLogDiv.style.bottom = '0';
  visualLogDiv.style.left = '0';
  visualLogDiv.style.width = '100%';
  visualLogDiv.style.zIndex = '99999';
  visualLogDiv.style.fontFamily = 'monospace';
  
  // Header con botón de minimizar
  const header = document.createElement('div');
  header.style.backgroundColor = '#333';
  header.style.color = '#fff';
  header.style.padding = '4px 8px';
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.fontSize = '12px';
  header.innerHTML = '<span>Logs de Debug (iOS)</span><button id="toggle-log" style="background:none;border:1px solid #fff;color:#fff;border-radius:4px;padding:2px 8px;">Ocultar</button>';
  
  // Contenedor de los textos
  logContentDiv = document.createElement('div');
  logContentDiv.style.backgroundColor = 'rgba(0,0,0,0.85)';
  logContentDiv.style.color = '#0f0';
  logContentDiv.style.overflowY = 'auto';
  logContentDiv.style.height = '150px';
  logContentDiv.style.fontSize = '10px';
  logContentDiv.style.padding = '8px';
  
  visualLogDiv.appendChild(header);
  visualLogDiv.appendChild(logContentDiv);
  document.body.appendChild(visualLogDiv);
  
  const btn = header.querySelector('#toggle-log');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (logContentDiv.style.display === 'none') {
      logContentDiv.style.display = 'block';
      btn.textContent = 'Ocultar';
    } else {
      logContentDiv.style.display = 'none';
      btn.textContent = 'Mostrar';
    }
  });
  
  // Ocultar por defecto para que no estorbe al crear la sala
  logContentDiv.style.display = 'none';
  btn.textContent = 'Mostrar';
  
  return visualLogDiv;
}

function uiLog(msg, color = '#0f0') {
  if (!visualLogDiv) createVisualLog();
  const p = document.createElement('div');
  p.style.color = color;
  p.style.marginBottom = '3px';
  p.style.wordBreak = 'break-word';
  p.textContent = `[${new Date().toISOString().split('T')[1].slice(0,-1)}] ${msg}`;
  logContentDiv.appendChild(p);
  logContentDiv.scrollTop = logContentDiv.scrollHeight;
}

console.log = (...args) => {
  _originalLog(...args);
  uiLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), '#0f0');
};
console.error = (...args) => {
  _originalError(...args);
  uiLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), '#f00');
};
console.warn = (...args) => {
  _originalWarn(...args);
  uiLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), '#ff0');
};
// --- FIN VISUAL LOG ---

// ── Estado local ──────────────────────────────────────────────────────────
const state = {
  role:      null,   // 'host' | 'guest'
  roomId:    null,
  hostLang:  null,
  guestLang: null,
  myLang:    null,   // idioma del usuario actual
  theirLang: null,   // idioma del otro participante
};

// Selección temporal para Crear sala
const selection = { hostLang: null, guestLang: null };

// Exponer funciones de envío de audio globalmente para que audioCapture.js pueda llamarlas
window.emitAudioChunk = function(roomId, role, data, seq) {
  emitAudioChunk(roomId, role, data, seq);
};

window.emitAudioEnd = function(roomId, role, seq, mimeType) {
  emitAudioEnd(roomId, role, seq, mimeType);
};

// ── Inicialización ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connectSocket();
  bindHomeButtons();
  bindCreateScreen();
  bindWaitingScreen();
  bindJoinScreen();
  bindSessionScreen();
  checkURLForRoomCode();
});

// ── Handlers globales de Socket (llamados desde socket.js) ────────────────
window.DuoTalk = {

  onRoomCreated({ roomId, hostLang, guestLang, expiresAt }) {
    state.role      = 'host';
    state.roomId    = roomId;
    state.hostLang  = hostLang;
    state.guestLang = guestLang;
    state.myLang    = hostLang;
    state.theirLang = guestLang;

    saveSession(roomId, 'host');

    const url = `${window.location.origin}?sala=${roomId}`;
    renderQR(url);
    displayRoomCode(roomId);

    const hName = LANGUAGES.find(l => l.code === hostLang)?.name || hostLang;
    const gName = LANGUAGES.find(l => l.code === guestLang)?.name || guestLang;
    document.getElementById('lang-summary').textContent = `${hName} ↔ ${gName}`;

    showScreen('waiting');
  },

  onRoomJoined({ roomId, hostLang, guestLang }) {
    // Ambos reciben este evento — determinar rol por estado actual
    if (!state.role) {
      state.role      = 'guest';
      state.roomId    = roomId;
      state.hostLang  = hostLang;
      state.guestLang = guestLang;
      state.myLang    = guestLang;
      state.theirLang = hostLang;
      saveSession(roomId, 'guest');
    }

    hideSuspendedModal();
    setSessionLangs(hostLang, guestLang);
    showScreen('session');
    startSessionTimer();
  },

  onRoomSuspended({ roomId, disconnectedRole, resumeDeadline }) {
    showSuspendedModal(disconnectedRole, resumeDeadline);
  },

  onRoomClosed({ roomId, reason }) {
    stopSessionTimer();
    clearSession();
    hideSuspendedModal();

    const messages = {
      timeout: 'La sala cerró por inactividad.',
      manual:  'La sesión ha terminado.',
      error:   'La sala cerró por un error.',
    };
    showErrorModal('Sesión terminada', messages[reason] || 'La sesión ha terminado.');

    clearSessionUI();

    // Reset de estado
    Object.assign(state, { role: null, roomId: null, hostLang: null, guestLang: null });
    Object.assign(selection, { hostLang: null, guestLang: null });
  },

  onRoomError({ code, message }) {
    hideInlineError('create-error');
    hideInlineError('join-error');

    if (['ROOM_NOT_FOUND','ROOM_CLOSED','ROOM_FULL','ROOM_NOT_AVAILABLE'].includes(code)) {
      showInlineError('join-error', message);
    } else {
      showErrorModal('Error', message);
    }
  },

  onTranslationReady({ fromRole, originalText, translatedText, audioData, isAudioChunk }) {
    if (isAudioChunk && audioData) {
      // Reproducir chunk de audio
      window.globalAudioPlayer.enqueue(audioData);
    } else {
      // Texto completo -> añadir burbuja
      hideProcessing();
      addBubble({
        role: fromRole,
        originalText,
        translatedText,
        originalLang: fromRole === 'host' ? state.hostLang : state.guestLang,
        targetLang:   fromRole === 'host' ? state.guestLang : state.hostLang,
      });
    }
  },

  onTranslationError({ reason, retry }) {
    hideProcessing();
    if (!retry) {
      showErrorModal('Error de traducción', 'No se pudo procesar el audio. Intenta de nuevo.');
    }
  },

  onTurnBlocked({ activeRole }) {
    showTurnBlocked(activeRole);
    document.getElementById('btn-mic').disabled = true;
  },

  onTurnFree() {
    hideTurnBlocked();
    document.getElementById('btn-mic').disabled = false;
  },

  onSessionSaved({ sessionId }) {
    clearSession();
    clearSessionUI();
    showScreen('home');
  },
};

// ── Botones: Pantalla Inicio ──────────────────────────────────────────────
function bindHomeButtons() {
  document.getElementById('btn-create').addEventListener('click', () => {
    selection.hostLang  = null;
    selection.guestLang = null;
    renderLangPicker('lang-grid-host',  null, null, (code) => {
      selection.hostLang = code;
      renderLangPicker('lang-grid-host',  code, selection.guestLang, (c) => { selection.hostLang = c; refreshGuestPicker(); });
      refreshGuestPicker();
      hideInlineError('create-error');
    });
    renderLangPicker('lang-grid-guest', null, null, (code) => {
      selection.guestLang = code;
      refreshHostPicker();
      hideInlineError('create-error');
    });
    showScreen('create');
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    document.getElementById('join-code-input').value = '';
    hideInlineError('join-error');
    showScreen('join');
  });
}

// ── Botones: Crear sala ───────────────────────────────────────────────────
function bindCreateScreen() {
  document.getElementById('btn-start-room').addEventListener('click', () => {
    if (!selection.hostLang) {
      return showInlineError('create-error', 'Selecciona tu idioma.');
    }
    if (!selection.guestLang) {
      return showInlineError('create-error', 'Selecciona el idioma del extranjero.');
    }
    if (selection.hostLang === selection.guestLang) {
      return showInlineError('create-error', 'Los idiomas no pueden ser iguales.');
    }
    hideInlineError('create-error');
    
    // Pre-solicitar permiso de micrófono mediante gesto del usuario (click)
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        stream.getTracks().forEach(track => track.stop());
        console.log('[DuoTalk] Permiso de micrófono pre-autorizado (Host)');
      })
      .catch(err => console.warn('[DuoTalk] Permiso de micrófono denegado:', err));

    emitCreateRoom(selection.hostLang, selection.guestLang);
  });
}

// ── Botones: Esperando ────────────────────────────────────────────────────
function bindWaitingScreen() {
  document.getElementById('btn-cancel-wait').addEventListener('click', () => {
    if (state.roomId) emitLeaveRoom(state.roomId);
    clearSession();
    showScreen('home');
  });

  document.getElementById('btn-copy-code').addEventListener('click', () => {
    const code = document.getElementById('room-code-display').textContent;
    navigator.clipboard?.writeText(code);
    document.getElementById('btn-copy-code').textContent = '✓ Copiado';
    setTimeout(() => { document.getElementById('btn-copy-code').textContent = 'Copiar'; }, 2000);
  });
}

// ── Botones: Unirse ───────────────────────────────────────────────────────
function bindJoinScreen() {
  const input = document.getElementById('join-code-input');

  // Auto-submit al completar 6 caracteres
  input.addEventListener('input', () => {
    if (input.value.length === 6) {
      document.getElementById('btn-do-join').click();
    }
  });

  document.getElementById('btn-do-join').addEventListener('click', () => {
    const code = input.value.trim().toUpperCase();
    if (code.length !== 6) {
      return showInlineError('join-error', 'El código debe tener 6 caracteres.');
    }
    hideInlineError('join-error');
    
    // Pre-solicitar permiso de micrófono mediante gesto del usuario (click)
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        stream.getTracks().forEach(track => track.stop());
        console.log('[DuoTalk] Permiso de micrófono pre-autorizado (Guest)');
      })
      .catch(err => console.warn('[DuoTalk] Permiso de micrófono denegado:', err));

    emitJoinRoom(code);
  });
}

// ── Botones: Sesión ───────────────────────────────────────────────────────
function bindSessionScreen() {
  document.getElementById('btn-end-session').addEventListener('click', () => {
    if (state.roomId) emitLeaveRoom(state.roomId);
    stopSessionTimer();
    clearSession();
    showScreen('home');
  });

  // Micrófono — Fase 3: grabar y enviar audio
  const btnMic = document.getElementById('btn-mic');
  let isMicPressed = false;
  let captureReady = false;

  btnMic.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    if (isMicPressed) return;
    isMicPressed = true;
    captureReady = false;
    window.globalAudioPlayer.init();

    // Mostrar estado "preparando" mientras iOS resuelve el permiso
    btnMic.classList.add('active');
    btnMic.style.opacity = '0.6';
    const origText = btnMic.querySelector('.mic-label')?.textContent;

    try {
      await window.startAudioCapture(state.role, state.roomId);
      captureReady = true;
      btnMic.style.opacity = '1';

      // Si el usuario ya soltó mientras esperaba el permiso → detener inmediatamente
      if (!isMicPressed) {
        btnMic.classList.remove('active');
        const wasRecording = window.stopAudioCapture(state.role, state.roomId);
        if (wasRecording) showProcessing();
      }
    } catch (err) {
      isMicPressed = false;
      captureReady = false;
      btnMic.classList.remove('active');
      btnMic.style.opacity = '1';
      showErrorModal('Micrófono', 'No se pudo acceder al micrófono. Verifica los permisos.');
    }
  });

  const endCapture = (e) => {
    e.preventDefault();
    isMicPressed = false;
    if (!btnMic.classList.contains('active')) return;

    // Si startCapture aún no terminó → el flag isMicPressed=false
    // hará que el handler de arriba llame stopAudioCapture cuando resuelva
    if (!captureReady) return;

    btnMic.classList.remove('active');
    btnMic.style.opacity = '1';
    const wasRecording = window.stopAudioCapture(state.role, state.roomId);
    if (wasRecording) showProcessing();
  };

  btnMic.addEventListener('pointerup', endCapture);
  btnMic.addEventListener('pointerleave', endCapture);
  btnMic.addEventListener('touchend', endCapture);
  btnMic.addEventListener('touchcancel', endCapture);
}

// ── Detección de código en URL (?sala=ABC123) ────────────────────────────
function checkURLForRoomCode() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('sala');
  if (code && code.length === 6) {
    emitJoinRoom(code.toUpperCase());
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function refreshHostPicker() {
  renderLangPicker('lang-grid-host', selection.hostLang, selection.guestLang, (code) => {
    selection.hostLang = code;
    refreshGuestPicker();
    hideInlineError('create-error');
  });
}

function refreshGuestPicker() {
  renderLangPicker('lang-grid-guest', selection.guestLang, selection.hostLang, (code) => {
    selection.guestLang = code;
    refreshHostPicker();
    hideInlineError('create-error');
  });
}
