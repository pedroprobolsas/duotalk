/**
 * socketHandlers.js  — Fase 3: integración gpt-realtime-translate
 *
 * Contratos exactos de eventos Socket.io (Sección 6 — DuoTalk v1.1)
 * Validaciones de conexión y audio (Sección 4.1 y 4.2)
 * Turno: TurnManager | Audio buffer: AudioBuffer
 * Traducción: TranslationManager → gpt-realtime-translate (skill §5)
 *
 * Fase 3 primer entregable: solo host → guest (sesión A).
 * Sesión B (guest → host) se activa con OK de Pedro.
 */

import { ROOM_STATUS }        from '../rooms/roomManager.js';
import { audioBuffer }        from '../audio/audioBuffer.js';
import { turnManager }        from '../audio/turnManager.js';
import { TranslationManager } from '../translation/translationManager.js';

// Map global: roomId → TranslationManager
const translationManagers = new Map();

// Umbral mínimo de audio antes de procesar (§4.2 — 500ms ≈ ≥1 chunk de 250ms)
const MIN_AUDIO_BYTES = 1600;

export function registerSocketHandlers(io, roomManager) {

  io.on('connection', (socket) => {
    console.log(`[SOCKET] +connect ${socket.id}`);

    // ── room:create ─────────────────────────────────────────────────────────
    socket.on('room:create', ({ hostLang, guestLang } = {}) => {
      if (!hostLang || !guestLang) {
        return socket.emit('room:error', {
          code:    'INVALID_LANGS',
          message: 'Debes seleccionar ambos idiomas.',
        });
      }
      if (hostLang === guestLang) {
        return socket.emit('room:error', {
          code:    'SAME_LANG',
          message: 'Los idiomas no pueden ser iguales.',
        });
      }

      try {
        const room = roomManager.createRoom({ hostSocketId: socket.id, hostLang, guestLang });
        socket.join(room.id);
        socket.data.roomId = room.id;
        socket.data.role   = 'host';

        socket.emit('room:created', {
          roomId:    room.id,
          hostLang:  room.hostLang,
          guestLang: room.guestLang,
          expiresAt: room.expiresAt,
        });
      } catch (err) {
        socket.emit('room:error', {
          code:    err.message,
          message: err.message === 'MAX_ROOMS_REACHED'
            ? 'El servidor está al límite de capacidad.'
            : 'Error al crear la sala.',
        });
      }
    });

    // ── room:join ───────────────────────────────────────────────────────────
    socket.on('room:join', ({ roomId, role } = {}) => {
      const normalizedId = roomId?.toString().trim().toUpperCase();
      if (!normalizedId || normalizedId.length !== 6) {
        return socket.emit('room:error', { code: 'INVALID_ROOM_ID', message: 'Código inválido.' });
      }
      if (socket.data.roomId) {
        return socket.emit('room:error', { code: 'ALREADY_IN_ROOM', message: 'Ya estás en una sala.' });
      }

      // Reconexión en SUSPENDED
      const existingRoom = roomManager.getRoom(normalizedId);
      if (existingRoom?.status === ROOM_STATUS.SUSPENDED) {
        const missingRole = existingRoom.hostSocketId === null ? 'host' : 'guest';
        try {
          const room = roomManager.reconnectToRoom({ roomId: normalizedId, socketId: socket.id, role: missingRole });
          socket.join(room.id);
          socket.data.roomId = room.id;
          socket.data.role   = missingRole;
          io.to(room.id).emit('room:joined', { roomId: room.id, hostLang: room.hostLang, guestLang: room.guestLang });
          
          // Re-iniciar la sesión OpenAI que se limpió en el disconnect
          _startTranslation(room, io, roomManager);
          return;
        } catch {
          return socket.emit('room:error', { code: 'ROOM_NOT_RESUMABLE', message: 'El tiempo de reconexión expiró.' });
        }
      }

      // Unión normal como guest → inicia sesión de traducción
      try {
        const room = roomManager.joinRoom({ roomId: normalizedId, guestSocketId: socket.id });
        socket.join(room.id);
        socket.data.roomId = room.id;
        socket.data.role   = 'guest';

        // Notificar a ambos
        io.to(room.id).emit('room:joined', { roomId: room.id, hostLang: room.hostLang, guestLang: room.guestLang });

        // Iniciar sesión OpenAI — solo host→guest en Fase 3 primer entregable
        _startTranslation(room, io, roomManager);
      } catch (err) {
        const messages = {
          ROOM_NOT_FOUND:     'Sala no encontrada.',
          ROOM_CLOSED:        'Esta sala ya está cerrada.',
          ROOM_FULL:          'La sala ya tiene dos participantes.',
          ROOM_NOT_AVAILABLE: 'Esta sala no está disponible.',
        };
        socket.emit('room:error', { code: err.message, message: messages[err.message] || 'Error al unirse.' });
      }
    });

    // ── room:leave ──────────────────────────────────────────────────────────
    socket.on('room:leave', ({ roomId } = {}) => {
      _handleClose(roomId?.toUpperCase(), socket, io, roomManager);
    });

    // ── audio:chunk ─────────────────────────────────────────────────────────
    // El audio llega como WebM/Opus en base64 desde el browser.
    // Se convierte a PCM16 en translationManager.processAudio()
    socket.on('audio:chunk', async ({ roomId, role, data, seq } = {}) => {
      console.log(`[AUDIO] chunk recibido | sala=${roomId} | rol=${role} | bytes=${data?.length ?? 0}`);
      const room = roomManager.getRoom(roomId);
      if (!room || room.status !== ROOM_STATUS.ACTIVE) return;

      // Semáforo de turno (§4.2)
      if (!turnManager.isFree(roomId) && turnManager.getActiveRole(roomId) !== role) return;

      if (turnManager.isFree(roomId)) {
        turnManager.acquire(roomId, role);
        const otherSocket = role === 'host' ? room.guestSocketId : room.hostSocketId;
        if (otherSocket) io.to(otherSocket).emit('turn:blocked', { roomId, activeRole: role });
      }

      // En Fase 3 enviamos cada chunk directo a OpenAI (streaming continuo)
      // No acumulamos — el modelo necesita audio continuo incluyendo silencios (skill §2)
      const mgr = translationManagers.get(roomId);
      if (mgr && data) {
        await mgr.processAudio(role, data);
      }
    });

    // ── audio:end ───────────────────────────────────────────────────────────
    // Señal de fin de intervención (el usuario soltó el botón).
    socket.on('audio:end', ({ roomId, role, seq, mimeType } = {}, ackCallback) => {
      // Confirmar recepción inmediatamente (Socket.io ACK)
      if (typeof ackCallback === 'function') {
        ackCallback({ received: true, roomId, role, seq, serverTime: Date.now() });
      }
      socket.emit('translation:error', { roomId, reason: `[DEBUG SOCKET] audio:end ENTRÓ. role=${role}, seq=${seq}`, retry: false });

      const room = roomManager.getRoom(roomId);
      if (!room) {
        socket.emit('translation:error', { roomId, reason: `[DEBUG SOCKET] Room undefined!`, retry: false });
        return;
      }
      if (room.status !== ROOM_STATUS.ACTIVE) {
        socket.emit('translation:error', { roomId, reason: `[DEBUG SOCKET] Room status no es ACTIVE: ${room.status}`, retry: false });
        return;
      }
      
      const activeRole = turnManager.getActiveRole(roomId);
      if (activeRole !== role) {
        console.warn(`[SOCKET] audio:end ignorado. role=${role}, active=${activeRole}`);
        socket.emit('translation:error', { roomId, reason: `[DEBUG SOCKET] Turno inválido. role=${role}, activeRole=${activeRole}`, retry: false });
        return;
      }

      // Esperar 500ms para asegurar que el último audio:chunk haya sido procesado
      setTimeout(() => {
        const mgr = translationManagers.get(roomId);
        if (mgr) {
          socket.emit('translation:error', { roomId, reason: `[DEBUG SOCKET] Ejecutando commitAudio tras 500ms...`, retry: false });
          mgr.commitAudio(role, mimeType || 'audio/webm');
        } else {
          socket.emit('translation:error', { roomId, reason: `[DEBUG SOCKET] translationManager undefined`, retry: false });
        }
        console.log(`[SOCKET] audio:end roomId=${roomId} role=${role} mime=${mimeType || 'audio/webm'} — Commit enviado con retraso de 500ms`);
      }, 500);
    });

    // ── session:save ─────────────────────────────────────────────────────────
    socket.on('session:save', ({ roomId, category, notes } = {}) => {
      console.log(`[SESSION] save: roomId=${roomId} category=${category}`);
      socket.emit('session:saved', { sessionId: 'PHASE_7_PENDING', filePath: null });
    });

    // ── disconnect ──────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[SOCKET] -disconnect ${socket.id} (${reason})`);

      const result = roomManager.handleDisconnect(socket.id);
      if (!result) return;

      const { room, disconnectedRole, resumeDeadline } = result;

      // Limpiar recursos
      audioBuffer.clearRoom(room.id);
      turnManager.release(room.id);

      // Cerrar sesiones OpenAI (se reabren en reconexión)
      const mgr = translationManagers.get(room.id);
      if (mgr) {
        mgr.close();
        translationManagers.delete(room.id);
      }

      socket.to(room.id).emit('room:suspended', { roomId: room.id, disconnectedRole, resumeDeadline });
      _watchRoomClose(room.id, roomManager, io);
    });
  });
}

// ── Privados ─────────────────────────────────────────────────────────────────

/**
 * Inicializa la sesión OpenAI cuando el guest se une.
 * Fase 3 primer entregable: solo sesión A (host → guest).
 */
async function _startTranslation(room, io, roomManager) {
  if (translationManagers.has(room.id)) return; // ya iniciada

  const mgr = new TranslationManager({
    roomId:   room.id,
    hostLang: room.hostLang,
    guestLang: room.guestLang,

    onTranslationReady: (payload) => {
      const targetSocketId = payload.fromRole === 'host'
        ? room.guestSocketId
        : room.hostSocketId;

      if (payload.isAudioChunk) {
        // Streaming de audio en tiempo real → solo al oyente
        if (targetSocketId) {
          io.to(targetSocketId).emit('translation:ready', {
            roomId:         room.id,
            fromRole:       payload.fromRole,
            originalText:   null,
            translatedText: null,
            audioData:      payload.audioData,
            isAudioChunk:   true,
          });
        }
      } else {
        // Texto completo → a ambos (para mostrar burbuja o destrabar UI)
        if (payload.originalText || payload.translatedText) {
          roomManager.addTranscriptEntry(room.id, {
            role:          payload.fromRole,
            originalLang:  payload.fromRole === 'host' ? room.hostLang : room.guestLang,
            targetLang:    payload.fromRole === 'host' ? room.guestLang : room.hostLang,
            originalText:  payload.originalText  ?? '',
            translatedText: payload.translatedText ?? '',
          });
        }
        
        io.to(room.id).emit('translation:ready', {
          roomId:         room.id,
          fromRole:       payload.fromRole,
          originalText:   payload.originalText,
          translatedText: payload.translatedText,
          audioData:      null,
          isAudioChunk:   false,
        });
      }
    },

    onTranslationError: (payload) => {
      io.to(room.id).emit('translation:error', { roomId: room.id, ...payload });
    },

    onTurnFree: (_role) => {
      turnManager.release(room.id);
      io.to(room.id).emit('turn:free', { roomId: room.id });
    },
  });

  translationManagers.set(room.id, mgr);

  try {
    // ── Fase 3 primer entregable: solo sesión A ──────────────────────────
    await mgr.initHostToGuest();
    console.log(`[TRANSLATE] Sesión A iniciada para sala ${room.id}`);

    // ── Descomentar para activar bidireccional (Fase 3 segundo entregable) ──
    // await mgr.initGuestToHost();
    // console.log(`[TRANSLATE] Sesión B iniciada para sala ${room.id}`);
  } catch (err) {
    console.error(`[TRANSLATE] Error iniciando sesión para sala ${room.id}:`, err.message);
    io.to(room.id).emit('translation:error', {
      roomId: room.id,
      reason: 'No se pudo conectar con el servicio de traducción.',
      retry:  false,
    });
  }
}

function _handleClose(roomId, socket, io, roomManager) {
  if (!roomId) return;
  try {
    const room = roomManager.initiateClose(roomId);
    audioBuffer.clearRoom(roomId);
    turnManager.clearRoom(roomId);

    const mgr = translationManagers.get(roomId);
    if (mgr) { mgr.close(); translationManagers.delete(roomId); }

    io.to(room.id).emit('room:closed', { roomId: room.id, reason: 'manual' });
    roomManager.finalizeClose(room.id);
  } catch (err) {
    socket.emit('room:error', { code: err.message, message: 'Error al cerrar la sala.' });
  }
}

function _watchRoomClose(roomId, roomManager, io) {
  const check = setInterval(() => {
    const room = roomManager.getRoom(roomId);
    if (!room || room.status === ROOM_STATUS.CLOSED) {
      if (room?.status === ROOM_STATUS.CLOSED && room._reason === 'timeout') {
        io.to(roomId).emit('room:closed', { roomId, reason: 'timeout' });
      }
      clearInterval(check);
    }
  }, 5_000);
  setTimeout(() => clearInterval(check), 90_000);
}
