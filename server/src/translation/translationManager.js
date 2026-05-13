/**
 * translationManager.js
 * Gestiona DOS sesiones OpenAI por sala — una por dirección (skill §5).
 *
 * Fase 3 — Primer entregable: solo sesión A (host habla → guest escucha).
 * Sesión B (guest → host) se activa cuando el bidireccional esté verificado.
 *
 * Flujo:
 *   audio WebM/Opus (cliente)
 *   → convertWebmToPcm16 (ffmpeg)
 *   → TranslationSession.sendAudio()
 *   → OpenAI gpt-realtime-translate
 *   → translation:ready (Socket.io → cliente destino)
 */

import { TranslationSession } from './translationSession.js';
import { convertWebmToPcm16 }  from './audioConverter.js';

export class TranslationManager {
  /**
   * @param {object} opts
   * @param {string}   opts.roomId
   * @param {string}   opts.hostLang   ISO 639-1 del host
   * @param {string}   opts.guestLang  ISO 639-1 del guest
   * @param {Function} opts.onTranslationReady  (payload) → void — emite al Socket
   * @param {Function} opts.onTranslationError  (payload) → void
   * @param {Function} opts.onTurnFree  (role) → void
   */
  constructor({ roomId, hostLang, guestLang,
                onTranslationReady, onTranslationError, onTurnFree }) {
    this.roomId   = roomId;
    this.hostLang = hostLang;
    this.guestLang= guestLang;

    this.onTranslationReady  = onTranslationReady;
    this.onTranslationError  = onTranslationError;
    this.onTurnFree          = onTurnFree;

    // Sesión A: host habla → guest escucha (FASE 3 primer entregable)
    this._sessionA = null;
    // Sesión B: guest habla → host escucha (FASE 3 segundo entregable)
    this._sessionB = null;

    // Audio delta buffer por dirección (para emitir chunks continuos)
    this._audioBufferA = [];
  }

  // ── Inicializar solo sesión A (host → guest) ─────────────────────────────
  async initHostToGuest() {
    this._sessionA = new TranslationSession({
      roomId:      this.roomId,
      speakerRole: 'host',
      inputLang:   this.hostLang,
      outputLang:  this.guestLang,

      onTextDone: (originalText, translatedText) => {
        this.onTranslationReady({
          fromRole:       'host',
          originalText,
          translatedText,
          audioData:      null, // el audio ya se envió en tiempo real via onAudioDelta
        });
        // Liberar turno cuando el texto esté completo
        this.onTurnFree('host');
      },

      onAudioDelta: (base64Chunk) => {
        // Streaming de audio al guest en tiempo real
        this.onTranslationReady({
          fromRole:       'host',
          originalText:   null,
          translatedText: null,
          audioData:      base64Chunk,
          isAudioChunk:   true, // flag para que el cliente lo encole sin mostrar burbuja
        });
      },

      onAudioDone: () => {
        console.log(`[TranslationManager][${this.roomId}] Audio host→guest completo`);
      },

      onError: (err) => {
        this.onTranslationError({
          reason: err.message || 'Error de traducción',
          retry:  err.code !== 'language_not_supported',
        });
        this.onTurnFree('host');
      },
    });

    await this._sessionA.open();
    console.log(`[TranslationManager][${this.roomId}] Sesión A lista (${this.hostLang}→${this.guestLang})`);
  }

  // ── Inicializar sesión B (guest → host) — activar en Fase 3 bidireccional ─
  async initGuestToHost() {
    this._sessionB = new TranslationSession({
      roomId:      this.roomId,
      speakerRole: 'guest',
      inputLang:   this.guestLang,
      outputLang:  this.hostLang,

      onTextDone: (originalText, translatedText) => {
        this.onTranslationReady({
          fromRole:       'guest',
          originalText,
          translatedText,
          audioData:      null,
        });
        this.onTurnFree('guest');
      },

      onAudioDelta: (base64Chunk) => {
        this.onTranslationReady({
          fromRole:       'guest',
          originalText:   null,
          translatedText: null,
          audioData:      base64Chunk,
          isAudioChunk:   true,
        });
      },

      onAudioDone: () => {
        console.log(`[TranslationManager][${this.roomId}] Audio guest→host completo`);
      },

      onError: (err) => {
        this.onTranslationError({
          reason: err.message || 'Error de traducción',
          retry:  true,
        });
        this.onTurnFree('guest');
      },
    });

    await this._sessionB.open();
    console.log(`[TranslationManager][${this.roomId}] Sesión B lista (${this.guestLang}→${this.hostLang})`);
  }

  // ── Procesar audio entrante ───────────────────────────────────────────────
  /**
   * Recibe un chunk de audio WebM/Opus en base64, lo convierte a PCM16
   * y lo reenvía a la sesión OpenAI correspondiente.
   *
   * @param {string} role     'host' | 'guest'
   * @param {string} webmB64  audio en base64 (WebM/Opus del browser)
   */
  async processAudio(role, webmB64) {
    try {
      const pcm16B64 = await convertWebmToPcm16(webmB64);

      if (role === 'host' && this._sessionA?.isReady) {
        this._sessionA.sendAudio(pcm16B64);
      } else if (role === 'guest' && this._sessionB?.isReady) {
        this._sessionB.sendAudio(pcm16B64);
      }
    } catch (err) {
      console.error(`[TranslationManager][${this.roomId}] Conversión de audio fallida: ${err.message}`);
      // No propagar el error — un chunk fallido no debe cerrar la sala
    }
  }

  // ── Forzar el procesamiento al soltar el botón ────────────────────────────
  commitAudio(role) {
    if (role === 'host' && this._sessionA?.isReady) {
      this._sessionA.commitAudio();
    } else if (role === 'guest' && this._sessionB?.isReady) {
      this._sessionB.commitAudio();
    }
  }

  // ── Estado de las sesiones ────────────────────────────────────────────────
  get hostSessionReady()  { return this._sessionA?.isReady ?? false; }
  get guestSessionReady() { return this._sessionB?.isReady ?? false; }

  // ── Cierre limpio ─────────────────────────────────────────────────────────
  close() {
    this._sessionA?.close();
    this._sessionB?.close();
    console.log(`[TranslationManager][${this.roomId}] Sesiones cerradas`);
  }
}
