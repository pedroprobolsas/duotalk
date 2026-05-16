/**
 * translationSession.js
 * Gestiona UNA sesión WebSocket con gpt-realtime-translate.
 * Una sesión = una dirección de traducción (input lang → output lang).
 *
 * Skill: openai-realtime-voice-2026.md
 * Endpoint: wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate
 * Audio formato requerido: PCM16, 24kHz, mono, base64
 */

import WebSocket from 'ws';

const OPENAI_WS_URL =
  'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';

// Reapertura automática a los 55 min (límite API: 60 min)
const SESSION_RENEW_MS = 55 * 60_000;

export class TranslationSession {
  /**
   * @param {object} opts
   * @param {string}   opts.roomId
   * @param {string}   opts.speakerRole  'host' | 'guest'
   * @param {string}   opts.inputLang    código ISO 639-1 del hablante
   * @param {string}   opts.outputLang   código ISO 639-1 del oyente
   * @param {Function} opts.onTextDone   (transcript, translatedText) → void
   * @param {Function} opts.onAudioDelta (base64Chunk) → void
   * @param {Function} opts.onAudioDone  () → void
   * @param {Function} opts.onError      (err) → void
   */
  constructor({ roomId, speakerRole, inputLang, outputLang,
                onTextDone, onAudioDelta, onAudioDone, onError }) {
    this.roomId      = roomId;
    this.speakerRole = speakerRole;
    this.inputLang   = inputLang;
    this.outputLang  = outputLang;

    // Callbacks hacia el caller (socketHandlers)
    this.onTextDone   = onTextDone;
    this.onAudioDelta = onAudioDelta;
    this.onAudioDone  = onAudioDone;
    this.onError      = onError;

    this._ws          = null;
    this._ready       = false;
    this._renewTimer  = null;

    // Acumuladores para el texto parcial (para la burbuja)
    this._inputTranscript    = '';
    this._translatedText     = '';
  }

  // ── Abrir la sesión WebSocket con OpenAI ──────────────────────────────────
  open() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(OPENAI_WS_URL, {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      });

      const timeout = setTimeout(() => {
        reject(new Error(`[Room ${this.roomId}] OpenAI WS connection timeout`));
      }, 10_000);

      this._ws.once('open', () => {
        // Configurar sesión según skill §3.2
        this._ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            audio: {
              input: {
                transcription: {
                  model: 'gpt-realtime-whisper',
                },
                noise_reduction: { type: 'near_field' },
              },
              output: {
                language: this.outputLang,
              },
            },
          },
        }));
      });

      this._ws.on('message', (raw) => {
        const event = JSON.parse(raw.toString());

        if (event.type === 'session.created') {
          clearTimeout(timeout);
          console.log(`[OpenAI][${this.roomId}][${this.speakerRole}] Sesión lista: ${event.session?.id}`);
          this._ready = true;
          this._scheduleRenew();
          resolve(this);
          return;
        }

        this._handleEvent(event);
      });

      this._ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error(`[OpenAI][${this.roomId}][${this.speakerRole}] WS error: ${err.message}`);
        this._ready = false;
        this.onError(err);
        reject(err);
      });

      this._ws.on('close', (code, reason) => {
        console.log(`[OpenAI][${this.roomId}][${this.speakerRole}] WS closed: ${code} ${reason}`);
        this._ready = false;
        clearTimeout(this._renewTimer);
      });
    });
  }

  // ── Enviar chunk de audio (ya convertido a PCM16 base64) ─────────────────
  sendAudio(pcm16Base64) {
    if (!this._ready || this._ws?.readyState !== WebSocket.OPEN) return;

    this._ws.send(JSON.stringify({
      type:  'input_audio_buffer.append',
      audio: pcm16Base64,
    }));
  }

  // ── Forzar el commit del audio para que VAD procese si se corta el stream ─
  commitAudio() {
    if (!this._ready || this._ws?.readyState !== WebSocket.OPEN) return;

    this._ws.send(JSON.stringify({
      type: 'input_audio_buffer.commit'
    }));

    // Forzar explícitamente la respuesta si VAD falla en detectarlo
    this._ws.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['text', 'audio']
      }
    }));
  }

  // ── Cerrar sesión limpiamente ─────────────────────────────────────────────
  close() {
    clearTimeout(this._renewTimer);
    this._ready = false;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.close();
    }
  }

  get isReady() { return this._ready; }

  // ── Eventos de OpenAI Realtime API ────────────────────────────────────────
  _handleEvent(event) {
    // DEBUG: Loggear TODOS los eventos que responde OpenAI hacia el cliente usando onError
    if (!['translation.audio.delta', 'session.input_transcript.delta', 'translation.text.delta'].includes(event.type)) { 
      console.log(`[OpenAI][${this.inputLang}->${this.outputLang}] Evento recibido:`, event.type);
      this.onError(new Error(`[DEBUG EVENTO] ${event.type}`));
    }

    switch (event.type) {
      case 'session.created':
        // Confirmación de session.update — no hacer nada
        break;

      case 'session.input_transcript.delta':
        // Texto parcial del hablante (subtítulo en tiempo real)
        this._inputTranscript += event.delta ?? '';
        break;

      case 'session.input_transcript.done':
        // Transcripción completa del turno
        this._inputTranscript = event.transcript ?? this._inputTranscript;
        break;

      case 'translation.text.delta':
        // Texto traducido parcial
        this._translatedText += event.delta ?? '';
        break;

      case 'translation.text.done':
        // Texto traducido completo → disparar burbuja (o destrabar UI si está vacío)
        this._translatedText = event.text ?? this._translatedText;
        this.onTextDone(this._inputTranscript, this._translatedText);
        
        // Resetear acumuladores
        this._inputTranscript = '';
        this._translatedText  = '';
        break;

      case 'translation.audio.delta':
        // Chunk de audio traducido → enviar al oyente
        if (event.delta) {
          this.onAudioDelta(event.delta);
        }
        break;

      case 'translation.audio.done':
        // Fin del audio de este turno
        this.onAudioDone();
        break;

      case 'error': {
        const code = event.error?.code;
        console.error(`[OpenAI][${this.roomId}][${this.speakerRole}] Error: ${code}`, event.error);
        
        // Propagar el error al cliente para que no se quede cargando
        this.onError(new Error(event.error?.message || 'Error de API de OpenAI'));

        if (code === 'session_expired') {
          console.log(`[OpenAI][${this.roomId}] Reabriendo sesión expirada…`);
          this.open().catch((err) => this.onError(err));
        }
        break;
      }

      default:
        // Ignorar eventos no manejados silenciosamente
        break;
    }
  }

  // ── Renovación automática a los 55 minutos (§9) ───────────────────────────
  _scheduleRenew() {
    this._renewTimer = setTimeout(async () => {
      console.log(`[OpenAI][${this.roomId}][${this.speakerRole}] Renovando sesión (55 min)…`);
      this.close();
      try {
        await this.open();
      } catch (err) {
        this.onError(err);
      }
    }, SESSION_RENEW_MS);
  }
}
