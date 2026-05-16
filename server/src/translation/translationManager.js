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

    // Audio raw buffer para acumular chunks antes de enviarlos a ffmpeg
    this._rawAudioBufferA = [];
    this._rawAudioBufferB = [];
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
   * Recibe un chunk de audio en base64 (WebM/Opus o MP4/AAC) y lo acumula
   * en el buffer del rol correspondiente.
   *
   * @param {string} role     'host' | 'guest'
   * @param {string} webmB64  audio en base64 del browser
   */
  async processAudio(role, webmB64) {
    if (role === 'host') {
      this._rawAudioBufferA.push(Buffer.from(webmB64, 'base64'));
    } else if (role === 'guest') {
      this._rawAudioBufferB.push(Buffer.from(webmB64, 'base64'));
    }
  }

  // ── Forzar el procesamiento al soltar el botón ────────────────────────────
  async commitAudio(role, mimeType) {
    try {
      const buffers = role === 'host' ? this._rawAudioBufferA : this._rawAudioBufferB;
      const session = role === 'host' ? this._sessionA : this._sessionB;
      
      console.log(`[TranslationManager][${this.roomId}] commitAudio: role=${role}, buffers=${buffers.length}`);

      if (buffers.length > 0 && session?.isReady) {
        // Concatenar todos los chunks crudos
        const fullWebmB64 = Buffer.concat(buffers).toString('base64');
        console.log(`[TranslationManager][${this.roomId}] Llamando convertWebmToPcm16 con ${fullWebmB64.length} bytes base64`);
        
        // Convertir la pista completa
        const pcm16B64 = await convertWebmToPcm16(fullWebmB64, mimeType);
        console.log(`[TranslationManager][${this.roomId}] ffmpeg exitoso! Produjo ${pcm16B64.length} bytes PCM base64`);
        this.onTranslationError({ reason: `[DEBUG] ffmpeg exitoso: ${pcm16B64.length} bytes PCM enviados a OpenAI`, retry: true });
        
        session.sendAudio(pcm16B64);
        console.log(`[TranslationManager][${this.roomId}] Enviado PCM a OpenAI.`);
        
        // Enviar 1 segundo de silencio
        session.sendAudio(Buffer.alloc(48000, 0).toString('base64'));
        console.log(`[TranslationManager][${this.roomId}] Enviado 1 seg de silencio a OpenAI.`);
        
        session.commitAudio();
        console.log(`[TranslationManager][${this.roomId}] input_audio_buffer.commit enviado a OpenAI.`);
      } else if (session?.isReady) {
        session.sendAudio(Buffer.alloc(48000, 0).toString('base64'));
        session.commitAudio(); // por si acaso
        console.log(`[TranslationManager][${this.roomId}] Commit enviado con buffers vacíos (solo silencio).`);
      } else {
        console.warn(`[TranslationManager][${this.roomId}] Ignorado: buffers=${buffers.length}, sessionReady=${session?.isReady}`);
        this.onTranslationError({ reason: `Error: OpenAI session not ready (sessionReady=false)`, retry: true });
        this.onTurnFree(role);
      }
    } catch (err) {
      console.error(`[TranslationManager][${this.roomId}] Conversión completa de audio fallida: ${err.message}`);
      this.onTranslationError({ reason: `Error procesando audio: ${err.message}`, retry: true });
      this.onTurnFree(role);
    }

    // Vaciar buffers
    if (role === 'host') this._rawAudioBufferA = [];
    if (role === 'guest') this._rawAudioBufferB = [];
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
