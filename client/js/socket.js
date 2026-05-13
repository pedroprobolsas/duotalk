/**
 * socket.js — Wrapper del cliente Socket.io.
 * Contiene todos los listeners de eventos servidor→cliente (Sección 6.2).
 * La lógica de negocio vive en main.js, no aquí.
 */

let _socket = null;

function connectSocket() {
  if (_socket?.connected) return _socket;

  _socket = io(window.location.origin, {
    reconnectionAttempts: 5,
    reconnectionDelay:    1500,
  });

  // ── Eventos genéricos ──────────────────────────────────────────────────
  _socket.on('connect', () => {
    console.log('[SOCKET] Conectado:', _socket.id);
    // Intentar reconexión automática si estábamos en sesión
    const saved = _getSavedSession();
    if (saved) {
      _socket.emit('room:join', { roomId: saved.roomId, role: saved.role });
    }
  });

  _socket.on('disconnect', () => {
    console.log('[SOCKET] Desconectado del servidor');
  });

  // ── Eventos de sala (Sección 6.2) ──────────────────────────────────────
  _socket.on('room:created', (data) => {
    console.log('[SOCKET] room:created', data);
    window.DuoTalk?.onRoomCreated(data);
  });

  _socket.on('room:joined', (data) => {
    console.log('[SOCKET] room:joined', data);
    window.DuoTalk?.onRoomJoined(data);
  });

  _socket.on('room:suspended', (data) => {
    console.log('[SOCKET] room:suspended', data);
    window.DuoTalk?.onRoomSuspended(data);
  });

  _socket.on('room:closed', (data) => {
    console.log('[SOCKET] room:closed', data);
    window.DuoTalk?.onRoomClosed(data);
  });

  _socket.on('room:error', (data) => {
    console.warn('[SOCKET] room:error', data);
    window.DuoTalk?.onRoomError(data);
  });

  // ── Eventos de audio/traducción ─────────────────────────────────────────
  _socket.on('translation:ready', (data) => {
    window.DuoTalk?.onTranslationReady(data);
  });

  _socket.on('translation:error', (data) => {
    console.warn('[SOCKET] translation:error', data);
    window.DuoTalk?.onTranslationError(data);
  });

  _socket.on('turn:blocked', (data) => {
    window.DuoTalk?.onTurnBlocked(data);
  });

  _socket.on('turn:free', () => {
    window.DuoTalk?.onTurnFree();
  });

  _socket.on('session:saved', (data) => {
    window.DuoTalk?.onSessionSaved(data);
  });

  return _socket;
}

// ── Emisores (cliente → servidor) ─────────────────────────────────────────
function emitCreateRoom(hostLang, guestLang) {
  _socket?.emit('room:create', { hostLang, guestLang });
}

function emitJoinRoom(roomId) {
  _socket?.emit('room:join', { roomId: roomId.toUpperCase(), role: 'guest' });
}

function emitLeaveRoom(roomId) {
  _socket?.emit('room:leave', { roomId });
}

function emitAudioChunk(roomId, role, data, seq) {
  _socket?.emit('audio:chunk', { roomId, role, data, seq });
}

function emitAudioEnd(roomId, role, seq) {
  _socket?.emit('audio:end', { roomId, role, seq });
}

function emitSaveSession(roomId, category, notes) {
  _socket?.emit('session:save', { roomId, category, notes });
}

// ── Persistencia de sesión (reconexión automática) ────────────────────────
function saveSession(roomId, role) {
  localStorage.setItem('dt_session', JSON.stringify({ roomId, role, ts: Date.now() }));
}

function clearSession() {
  localStorage.removeItem('dt_session');
}

function _getSavedSession() {
  try {
    const raw = localStorage.getItem('dt_session');
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Ignorar sesiones guardadas hace más de 65 segundos (fuera de gracia)
    if (Date.now() - data.ts > 65_000) {
      clearSession();
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
