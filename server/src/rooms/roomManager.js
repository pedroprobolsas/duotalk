/**
 * roomManager.js
 * Gestiona el ciclo de vida de salas en memoria.
 * Máquina de estados: WAITING → ACTIVE → SUSPENDED → CLOSING → CLOSED
 *
 * REGLA: Solo el servidor cambia el estado — nunca el cliente directamente.
 */

import { nanoid } from 'nanoid';

// ── Constantes de configuración (sobreescribibles por ENV) ────────────────────
const ROOM_TTL_MS          = (parseInt(process.env.ROOM_TTL_MINUTES) || 30) * 60_000;
const RESUME_DEADLINE_MS   = (parseInt(process.env.RESUME_DEADLINE_SECONDS) || 60) * 1_000;
const WAITING_TIMEOUT_MS   = 5 * 60_000;  // 5 min sin guest → CLOSED
const CLOSED_CLEANUP_MS    = 5 * 60_000;  // 5 min en CLOSED → purgar de memoria
const MAX_ROOMS            = parseInt(process.env.MAX_ROOMS) || 50;

// ── Estados válidos ────────────────────────────────────────────────────────────
export const ROOM_STATUS = Object.freeze({
  WAITING:   'WAITING',
  ACTIVE:    'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CLOSING:   'CLOSING',
  CLOSED:    'CLOSED',
});

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  // ── Crear sala ─────────────────────────────────────────────────────────────
  createRoom({ hostSocketId, hostLang, guestLang }) {
    if (this.rooms.size >= MAX_ROOMS) {
      throw new Error('MAX_ROOMS_REACHED');
    }

    const roomId = nanoid(6).toUpperCase();

    /** @type {Room} */
    const room = {
      id:             roomId,
      hostSocketId,
      guestSocketId:  null,
      hostLang,
      guestLang,
      status:         ROOM_STATUS.WAITING,
      createdAt:      Date.now(),
      lastActivity:   Date.now(),
      expiresAt:      Date.now() + ROOM_TTL_MS,
      // Timer para WAITING sin guest
      _waitingTimer:  setTimeout(() => this._expireWaiting(roomId), WAITING_TIMEOUT_MS),
      // Timer para reconexión en SUSPENDED
      _resumeTimer:   null,
      // Timer para purgar memoria tras CLOSED
      _closedTimer:   null,
      // Transcripción para M9
      transcript:     [],
    };

    this.rooms.set(roomId, room);
    console.log(`[ROOM] Creada ${roomId} | host=${hostSocketId} | ${hostLang}↔${guestLang}`);
    return room;
  }

  // ── Guest se une ───────────────────────────────────────────────────────────
  joinRoom({ roomId, guestSocketId }) {
    const room = this._getValidRoom(roomId);

    if (room.status !== ROOM_STATUS.WAITING) {
      throw new Error(room.status === ROOM_STATUS.ACTIVE ? 'ROOM_FULL' : 'ROOM_NOT_AVAILABLE');
    }
    if (room.guestSocketId !== null) {
      throw new Error('ROOM_FULL');
    }

    clearTimeout(room._waitingTimer);
    room.guestSocketId  = guestSocketId;
    room.status         = ROOM_STATUS.ACTIVE;
    room.lastActivity   = Date.now();

    console.log(`[ROOM] Activa ${roomId} | guest=${guestSocketId}`);
    return room;
  }

  // ── Desconexión inesperada ─────────────────────────────────────────────────
  handleDisconnect(socketId) {
    const room = this._findRoomBySocket(socketId);
    if (!room) return null;

    if (room.status === ROOM_STATUS.CLOSED || room.status === ROOM_STATUS.CLOSING) return null;

    const disconnectedRole = room.hostSocketId === socketId ? 'host' : 'guest';
    const resumeDeadline   = Date.now() + RESUME_DEADLINE_MS;

    room.status       = ROOM_STATUS.SUSPENDED;
    room.lastActivity = Date.now();

    // Limpiar socket del rol desconectado (permite reconexión)
    if (disconnectedRole === 'host') {
      room.hostSocketId = null;
    } else {
      room.guestSocketId = null;
    }

    // Timer de gracia: 60 seg para reconectar
    room._resumeTimer = setTimeout(() => {
      this._closeRoom(room.id, 'timeout');
    }, RESUME_DEADLINE_MS);

    console.log(`[ROOM] Suspendida ${room.id} | ${disconnectedRole} desconectado`);
    return { room, disconnectedRole, resumeDeadline };
  }

  // ── Reconexión en estado SUSPENDED ────────────────────────────────────────
  reconnectToRoom({ roomId, socketId, role }) {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== ROOM_STATUS.SUSPENDED) {
      throw new Error('ROOM_NOT_RESUMABLE');
    }

    clearTimeout(room._resumeTimer);

    if (role === 'host') {
      room.hostSocketId = socketId;
    } else {
      room.guestSocketId = socketId;
    }

    room.status       = ROOM_STATUS.ACTIVE;
    room.lastActivity = Date.now();

    console.log(`[ROOM] Reanudada ${roomId} | ${role}=${socketId}`);
    return room;
  }

  // ── Cierre voluntario ──────────────────────────────────────────────────────
  initiateClose(roomId) {
    const room = this._getValidRoom(roomId);
    room.status       = ROOM_STATUS.CLOSING;
    room.lastActivity = Date.now();

    // Timeout de seguridad: 5 seg para que M9 guarde el resumen
    setTimeout(() => {
      if (room.status === ROOM_STATUS.CLOSING) {
        this._closeRoom(roomId, 'timeout');
      }
    }, 5_000);

    return room;
  }

  // ── Cerrar definitivamente ─────────────────────────────────────────────────
  finalizeClose(roomId) {
    this._closeRoom(roomId, 'manual');
  }

  // ── Agregar entrada a transcripción ────────────────────────────────────────
  addTranscriptEntry(roomId, { role, originalText, translatedText, originalLang, targetLang }) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.transcript.push({
      ts: Date.now(),
      role,
      originalLang,
      targetLang,
      originalText,
      translatedText,
    });

    // Límite de 50 burbujas en memoria (UI también lo respeta)
    if (room.transcript.length > 200) {
      room.transcript = room.transcript.slice(-200);
    }

    room.lastActivity = Date.now();
  }

  // ── Limpiar salas expiradas (llamado por cron) ─────────────────────────────
  cleanExpiredRooms() {
    const now = Date.now();
    let count = 0;

    for (const [id, room] of this.rooms) {
      const isActive   = room.status === ROOM_STATUS.ACTIVE || room.status === ROOM_STATUS.WAITING;
      const isInactive = isActive && (now - room.lastActivity > ROOM_TTL_MS);

      if (isInactive) {
        this._closeRoom(id, 'timeout');
        count++;
      }
    }
    return count;
  }

  // ── Obtener sala por socket ────────────────────────────────────────────────
  getRoomBySocket(socketId) {
    return this._findRoomBySocket(socketId);
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  // ── Privados ───────────────────────────────────────────────────────────────
  _getValidRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('ROOM_NOT_FOUND');
    if (room.status === ROOM_STATUS.CLOSED) throw new Error('ROOM_CLOSED');
    return room;
  }

  _findRoomBySocket(socketId) {
    for (const room of this.rooms.values()) {
      if (room.hostSocketId === socketId || room.guestSocketId === socketId) {
        return room;
      }
    }
    return null;
  }

  _expireWaiting(roomId) {
    const room = this.rooms.get(roomId);
    if (room && room.status === ROOM_STATUS.WAITING) {
      this._closeRoom(roomId, 'timeout');
    }
  }

  _closeRoom(roomId, reason) {
    const room = this.rooms.get(roomId);
    if (!room || room.status === ROOM_STATUS.CLOSED) return;

    clearTimeout(room._waitingTimer);
    clearTimeout(room._resumeTimer);

    room.status = ROOM_STATUS.CLOSED;
    room._reason = reason;

    console.log(`[ROOM] Cerrada ${roomId} | reason=${reason}`);

    // Purgar de memoria tras 5 min
    room._closedTimer = setTimeout(() => {
      this.rooms.delete(roomId);
      console.log(`[ROOM] Purgada de memoria: ${roomId}`);
    }, CLOSED_CLEANUP_MS);

    return room;
  }
}

export const roomManager = new RoomManager();
