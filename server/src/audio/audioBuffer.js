/**
 * audioBuffer.js
 * Acumula chunks de audio PCM (base64) enviados por el cliente
 * y los entrega ordenados por número de secuencia cuando llega audio:end.
 *
 * En Fase 3 este buffer se conectará con el proxy OpenAI Realtime.
 */

export class AudioBuffer {
  constructor() {
    /** @type {Map<string, {chunks: Map<number, string>, role: string}>} */
    this._buffers = new Map();
  }

  /**
   * Registrar un chunk de audio para una sala/rol.
   * @param {string} roomId
   * @param {string} role   'host' | 'guest'
   * @param {string} data   base64 PCM
   * @param {number} seq    número secuencial
   */
  addChunk(roomId, role, data, seq) {
    const key = `${roomId}:${role}`;
    if (!this._buffers.has(key)) {
      this._buffers.set(key, { chunks: new Map(), role });
    }
    this._buffers.get(key).chunks.set(seq, data);
  }

  /**
   * Vaciar y retornar el audio completo en orden secuencial.
   * @param {string} roomId
   * @param {string} role
   * @returns {string[]} array de chunks base64 ordenados
   */
  flushChunks(roomId, role) {
    const key = `${roomId}:${role}`;
    const buffer = this._buffers.get(key);
    if (!buffer) return [];

    const ordered = [...buffer.chunks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, data]) => data);

    this._buffers.delete(key);
    return ordered;
  }

  /**
   * Descartar buffer de una sala completa (al cerrarla).
   * @param {string} roomId
   */
  clearRoom(roomId) {
    for (const key of this._buffers.keys()) {
      if (key.startsWith(`${roomId}:`)) {
        this._buffers.delete(key);
      }
    }
  }

  /**
   * Retorna true si el buffer tiene al menos un chunk acumulado.
   */
  hasData(roomId, role) {
    const key = `${roomId}:${role}`;
    return (this._buffers.get(key)?.chunks.size ?? 0) > 0;
  }
}

export const audioBuffer = new AudioBuffer();
