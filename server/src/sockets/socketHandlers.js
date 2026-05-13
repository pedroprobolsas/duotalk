/**
 * socketHandlers.js
 * Contratos exactos de eventos según Sección 6 del documento DuoTalk v1.1.
 * Cliente → Servidor: room:create, room:join, room:leave, audio:chunk, audio:end, session:save
 * Servidor → Cliente: room:created, room:joined, room:suspended, room:closed, room:error,
 *                     translation:ready, translation:error, turn:blocked, turn:free, session:saved
 */

import { ROOM_STATUS } from '../rooms/roomManager.js';

export function registerSocketHandlers(io, roomManager) {

  io.on('connection', (socket) => {
    console.log(`[SOCKET] Conectado: ${socket.id}`);

    // ── room:create ─────────────────────────────────────────────────────────
    socket.on('room:create', ({ hostLang, guestLang }) => {
      try {
        if (!hostLang || !guestLang) {
          return socket.emit('room:error', { code: 'INVALID_LANGS', message: 'Selecciona ambos idiomas.' });
        }
        if (hostLang === guestLang) {
          return socket.emit('room:error', { code: 'SAME_LANG', message: 'Los idiomas no pueden ser iguales.' });
        }

        const room = roomManager.createRoom({ hostSocketId: socket.id, hostLang, guestLang });

        socket.join(room.id);
        socket.emit('room:created', {
          roomId:    room.id,
          hostLang:  room.hostLang,
          guestLang: room.guestLang,
          expiresAt: room.expiresAt,
        });
      } catch (err) {
        const msg = err.message === 'MAX_ROOMS_REACHED'
          ? 'El servidor está al límite de capacidad. Intenta más tarde.'
          : 'Error al crear la sala.';
        socket.emit('room:error', { code: err.message, message: msg });
      }
    });

    // ── room:join ───────────────────────────────────────────────────────────
    socket.on('room:join', ({ roomId, role }) => {
      try {
        // Solo el guest puede usar room:join; host ya está por room:create
        if (role !== 'guest') {
          return socket.emit('room:error', { code: 'INVALID_ROLE', message: 'Rol inválido.' });
        }

        const room = roomManager.joinRoom({ roomId: roomId?.toUpperCase(), guestSocketId: socket.id });

        socket.join(room.id);

        // Notificar a ambos participantes
        io.to(room.id).emit('room:joined', {
          roomId:    room.id,
          hostLang:  room.hostLang,
          guestLang: room.guestLang,
        });
      } catch (err) {
        const messages = {
          ROOM_NOT_FOUND:      'Sala no encontrada. Verifica el código.',
          ROOM_CLOSED:         'Esta sala ya está cerrada.',
          ROOM_FULL:           'Esta sala ya tiene dos participantes.',
          ROOM_NOT_AVAILABLE:  'Esta sala no está disponible.',
        };
        socket.emit('room:error', {
          code:    err.message,
          message: messages[err.message] || 'Error al unirse a la sala.',
        });
      }
    });

    // ── room:leave ──────────────────────────────────────────────────────────
    socket.on('room:leave', ({ roomId }) => {
      _initiateClose(roomId, socket, io, roomManager);
    });

    // ── audio:chunk ─────────────────────────────────────────────────────────
    // En Fase 1 solo registramos el evento — la lógica de audio va en Fase 3
    socket.on('audio:chunk', ({ roomId, role, data, seq }) => {
      const room = roomManager.getRoom(roomId);
      if (!room || room.status !== ROOM_STATUS.ACTIVE) return;
      // Placeholder: en Fase 3 se conecta con OpenAI Realtime API
      console.log(`[AUDIO] chunk roomId=${roomId} role=${role} seq=${seq} bytes=${data?.length ?? 0}`);
    });

    // ── audio:end ───────────────────────────────────────────────────────────
    socket.on('audio:end', ({ roomId, role, seq }) => {
      const room = roomManager.getRoom(roomId);
      if (!room || room.status !== ROOM_STATUS.ACTIVE) return;
      // Placeholder: en Fase 3 se procesa el audio acumulado
      console.log(`[AUDIO] end roomId=${roomId} role=${role} seq=${seq}`);
    });

    // ── session:save ────────────────────────────────────────────────────────
    socket.on('session:save', async ({ roomId, category, notes }) => {
      // Placeholder: en Fase 7 se implementa M9 completo (Claude API + guardado)
      console.log(`[SESSION] save roomId=${roomId} category=${category}`);
      socket.emit('session:saved', { sessionId: 'PHASE_7_PENDING', filePath: null });
    });

    // ── disconnect ──────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[SOCKET] Desconectado: ${socket.id}`);

      const result = roomManager.handleDisconnect(socket.id);
      if (!result) return;

      const { room, disconnectedRole, resumeDeadline } = result;

      // Notificar al otro participante
      socket.to(room.id).emit('room:suspended', {
        roomId:          room.id,
        disconnectedRole,
        resumeDeadline,
      });
    });
  });
}

// ── Helpers privados ─────────────────────────────────────────────────────────

function _initiateClose(roomId, socket, io, roomManager) {
  try {
    const room = roomManager.initiateClose(roomId?.toUpperCase());

    // Notificar a ambos que la sala está cerrando
    io.to(room.id).emit('room:closed', {
      roomId: room.id,
      reason: 'manual',
    });

    roomManager.finalizeClose(room.id);
  } catch (err) {
    socket.emit('room:error', { code: err.message, message: 'Error al cerrar la sala.' });
  }
}
