/**
 * socketHandlers.js  — M1 completo
 *
 * Contratos exactos de eventos Socket.io (Sección 6 — DuoTalk v1.1)
 * Validaciones de conexión y audio (Sección 4.1 y 4.2)
 * Gestión de turno via TurnManager
 * Acumulación de audio via AudioBuffer
 *
 * Cliente → Servidor:  room:create · room:join · room:leave
 *                      audio:chunk · audio:end · session:save
 *
 * Servidor → Cliente:  room:created · room:joined · room:suspended · room:closed · room:error
 *                      translation:ready · translation:error · turn:blocked · turn:free · session:saved
 */

import { ROOM_STATUS }  from '../rooms/roomManager.js';
import { audioBuffer }  from '../audio/audioBuffer.js';
import { turnManager }  from '../audio/turnManager.js';

// Umbral mínimo de duración de audio antes de enviar a la API (doc: §4.2 → 500ms)
// En base64 PCM 16kHz 16-bit mono, 500ms ≈ 16000 bytes → al menos 1 chunk con datos reales.
// Aquí validamos que haya al menos 1 chunk acumulado con longitud mínima.
const MIN_AUDIO_BYTES = 1600; // base64 ≈ 1.2 KB mínimo

export function registerSocketHandlers(io, roomManager) {

  io.on('connection', (socket) => {
    console.log(`[SOCKET] +connect ${socket.id}`);

    // ── room:create ─────────────────────────────────────────────────────────
    socket.on('room:create', ({ hostLang, guestLang } = {}) => {
      // Validación: idiomas presentes y distintos (§4.3)
      if (!hostLang || !guestLang) {
        return socket.emit('room:error', {
          code: 'INVALID_LANGS',
          message: 'Debes seleccionar ambos idiomas.',
        });
      }
      if (hostLang === guestLang) {
        return socket.emit('room:error', {
          code: 'SAME_LANG',
          message: 'Los idiomas no pueden ser iguales.',
        });
      }

      try {
        const room = roomManager.createRoom({
          hostSocketId: socket.id,
          hostLang,
          guestLang,
        });

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
            ? 'El servidor está al límite de capacidad. Intenta más tarde.'
            : 'Error al crear la sala.',
        });
      }
    });

    // ── room:join ───────────────────────────────────────────────────────────
    socket.on('room:join', ({ roomId, role } = {}) => {
      const normalizedId = roomId?.toString().trim().toUpperCase();

      // Validación básica de payload
      if (!normalizedId || normalizedId.length !== 6) {
        return socket.emit('room:error', {
          code:    'INVALID_ROOM_ID',
          message: 'Código de sala inválido.',
        });
      }

      // Un socket ya unido no puede volver a unirse (race condition §4.1)
      if (socket.data.roomId) {
        return socket.emit('room:error', {
          code:    'ALREADY_IN_ROOM',
          message: 'Ya estás en una sala activa.',
        });
      }

      // Reconexión en estado SUSPENDED (§4.1 + §4.3)
      const existingRoom = roomManager.getRoom(normalizedId);
      if (existingRoom?.status === ROOM_STATUS.SUSPENDED) {
        // Determinar qué rol falta y reconectar
        const missingRole = existingRoom.hostSocketId === null ? 'host' : 'guest';
        try {
          const room = roomManager.reconnectToRoom({
            roomId:   normalizedId,
            socketId: socket.id,
            role:     missingRole,
          });

          socket.join(room.id);
          socket.data.roomId = room.id;
          socket.data.role   = missingRole;

          // Notificar a ambos que la sala está activa de nuevo
          io.to(room.id).emit('room:joined', {
            roomId:    room.id,
            hostLang:  room.hostLang,
            guestLang: room.guestLang,
          });
          return;
        } catch {
          return socket.emit('room:error', {
            code:    'ROOM_NOT_RESUMABLE',
            message: 'El tiempo de reconexión expiró. La sala ya cerró.',
          });
        }
      }

      // Unión normal como guest
      try {
        const room = roomManager.joinRoom({
          roomId:        normalizedId,
          guestSocketId: socket.id,
        });

        socket.join(room.id);
        socket.data.roomId = room.id;
        socket.data.role   = 'guest';

        // Ambos participantes reciben room:joined
        io.to(room.id).emit('room:joined', {
          roomId:    room.id,
          hostLang:  room.hostLang,
          guestLang: room.guestLang,
        });
      } catch (err) {
        const messages = {
          ROOM_NOT_FOUND:     'Sala no encontrada. Verifica el código.',
          ROOM_CLOSED:        'Esta sala ya está cerrada.',
          ROOM_FULL:          'Esta sala ya tiene dos participantes.',
          ROOM_NOT_AVAILABLE: 'Esta sala no está disponible en este momento.',
        };
        socket.emit('room:error', {
          code:    err.message,
          message: messages[err.message] || 'Error al unirse a la sala.',
        });
      }
    });

    // ── room:leave ──────────────────────────────────────────────────────────
    socket.on('room:leave', ({ roomId } = {}) => {
      _handleClose(roomId?.toUpperCase(), socket, io, roomManager);
    });

    // ── audio:chunk ─────────────────────────────────────────────────────────
    socket.on('audio:chunk', ({ roomId, role, data, seq } = {}) => {
      const room = roomManager.getRoom(roomId);
      if (!room || room.status !== ROOM_STATUS.ACTIVE) return;

      // Validar que el turno esté libre o sea de este rol (§4.2)
      if (!turnManager.isFree(roomId) && turnManager.getActiveRole(roomId) !== role) {
        // Turno ocupado por el otro — ignorar silenciosamente
        // El cliente ya debería haber recibido turn:blocked y deshabilitado el mic
        return;
      }

      // Adquirir turno al primer chunk
      if (turnManager.isFree(roomId)) {
        turnManager.acquire(roomId, role);

        // Notificar al otro participante que debe esperar
        const otherSocketId = role === 'host' ? room.guestSocketId : room.hostSocketId;
        if (otherSocketId) {
          io.to(otherSocketId).emit('turn:blocked', { roomId, activeRole: role });
        }
      }

      // Acumular chunk en buffer
      if (data && seq !== undefined) {
        audioBuffer.addChunk(roomId, role, data, seq);
      }
    });

    // ── audio:end ───────────────────────────────────────────────────────────
    socket.on('audio:end', ({ roomId, role, seq } = {}) => {
      const room = roomManager.getRoom(roomId);
      if (!room || room.status !== ROOM_STATUS.ACTIVE) return;

      // Validar que sea efectivamente el turno de este rol
      if (turnManager.getActiveRole(roomId) !== role) return;

      // Extraer chunks ordenados
      const chunks = audioBuffer.flushChunks(roomId, role);

      // Validar duración mínima (§4.2 → mínimo 500ms ≈ MIN_AUDIO_BYTES)
      const totalBytes = chunks.reduce((acc, c) => acc + c.length, 0);
      if (totalBytes < MIN_AUDIO_BYTES) {
        console.log(`[AUDIO] Descartado (muy corto): ${totalBytes} bytes`);
        turnManager.release(roomId);
        _notifyTurnFree(roomId, room, io);
        return;
      }

      console.log(`[AUDIO] Listo para procesar: roomId=${roomId} role=${role} chunks=${chunks.length} bytes=${totalBytes}`);

      // ── Fase 3: aquí se conecta OpenAI Realtime ──────────────────────────
      // En Fase 2, simulamos la respuesta para validar el flujo completo de turno
      _simulateTranslation(io, room, role, chunks, roomManager);
    });

    // ── session:save ────────────────────────────────────────────────────────
    // Placeholder — implementación completa en Fase 7 (M9)
    socket.on('session:save', ({ roomId, category, notes } = {}) => {
      console.log(`[SESSION] Solicitud de guardado: roomId=${roomId} category=${category}`);
      // Fase 7: Claude API + guardado en VPS
      socket.emit('session:saved', { sessionId: 'PHASE_7_PENDING', filePath: null });
    });

    // ── disconnect ──────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[SOCKET] -disconnect ${socket.id} (${reason})`);

      const result = roomManager.handleDisconnect(socket.id);
      if (!result) return;

      const { room, disconnectedRole, resumeDeadline } = result;

      // Limpiar recursos de audio para este rol
      audioBuffer.clearRoom(room.id);
      turnManager.release(room.id);

      // Notificar al participante restante
      socket.to(room.id).emit('room:suspended', {
        roomId:          room.id,
        disconnectedRole,
        resumeDeadline,
      });

      // Escuchar el cierre definitivo del timer del roomManager
      // para emitir room:closed cuando el deadline expire
      _watchRoomClose(room.id, roomManager, io);
    });
  });
}

// ── Helpers privados ─────────────────────────────────────────────────────────

/**
 * Cierre voluntario de sala — flujo ACTIVE → CLOSING → CLOSED
 */
function _handleClose(roomId, socket, io, roomManager) {
  if (!roomId) return;
  try {
    const room = roomManager.initiateClose(roomId);

    // Limpiar recursos
    audioBuffer.clearRoom(roomId);
    turnManager.clearRoom(roomId);

    // Notificar a ambos
    io.to(room.id).emit('room:closed', { roomId: room.id, reason: 'manual' });
    roomManager.finalizeClose(room.id);
  } catch (err) {
    socket.emit('room:error', { code: err.message, message: 'Error al cerrar la sala.' });
  }
}

/**
 * Emitir turn:free al otro participante y liberar el semáforo.
 */
function _notifyTurnFree(roomId, room, io) {
  turnManager.release(roomId);
  // Notificar a todos en la sala que el turno está libre
  io.to(roomId).emit('turn:free', { roomId });
}

/**
 * Simulación de traducción para validar el flujo en Fase 2.
 * En Fase 3 este bloque se reemplaza por la llamada real a OpenAI Realtime.
 */
function _simulateTranslation(io, room, role, chunks, roomManager) {
  const sourceText = '[Audio recibido — traducción disponible en Fase 3]';
  const targetText = '[Translation available in Phase 3]';

  // Simular latencia de API (~800ms)
  setTimeout(() => {
    if (room.status !== ROOM_STATUS.ACTIVE) return;

    // Agregar a transcripción del roomManager (para M9)
    roomManager.addTranscriptEntry(room.id, {
      role,
      originalLang:    role === 'host' ? room.hostLang  : room.guestLang,
      targetLang:      role === 'host' ? room.guestLang : room.hostLang,
      originalText:    sourceText,
      translatedText:  targetText,
    });

    // Emitir resultado a ambos participantes
    io.to(room.id).emit('translation:ready', {
      roomId:         room.id,
      fromRole:       role,
      originalText:   sourceText,
      translatedText: targetText,
      audioData:      null, // Fase 3: audio sintetizado en base64
    });

    // Liberar turno
    _notifyTurnFree(room.id, room, io);
  }, 800);
}

/**
 * Polling para detectar cuando roomManager cierra una sala por timeout
 * y emitir room:closed a los participantes restantes.
 */
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

  // Auto-limpiar el interval tras 90 seg (deadline + margen)
  setTimeout(() => clearInterval(check), 90_000);
}
