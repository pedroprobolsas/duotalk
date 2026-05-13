/**
 * turnManager.js
 * Semáforo de turno de habla por sala.
 *
 * Regla del documento (sección 4.2):
 * - Si el servidor está procesando audio de A, ignora audio de B temporalmente.
 * - Indicador visual de "espera tu turno" → evento turn:blocked / turn:free.
 */

export class TurnManager {
  constructor() {
    /** @type {Map<string, string|null>} roomId → 'host'|'guest'|null */
    this._activeRole = new Map();
  }

  /**
   * Intentar adquirir el turno.
   * @returns {boolean} true si el turno fue otorgado
   */
  acquire(roomId, role) {
    const current = this._activeRole.get(roomId);
    if (current && current !== role) return false; // turno ocupado por el otro
    this._activeRole.set(roomId, role);
    return true;
  }

  /**
   * Liberar el turno de la sala.
   */
  release(roomId) {
    this._activeRole.set(roomId, null);
  }

  /**
   * @returns {'host'|'guest'|null}
   */
  getActiveRole(roomId) {
    return this._activeRole.get(roomId) ?? null;
  }

  /**
   * @returns {boolean}
   */
  isFree(roomId) {
    return !this._activeRole.get(roomId);
  }

  clearRoom(roomId) {
    this._activeRole.delete(roomId);
  }
}

export const turnManager = new TurnManager();
