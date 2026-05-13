/**
 * audioPlayer.js
 * Recibe chunks de audio PCM16 (base64) a 24kHz desde el servidor,
 * los decodifica y los reproduce secuencialmente usando Web Audio API.
 */

class AudioPlayer {
  constructor() {
    this.audioContext = null;
    this.queue = [];
    this.playing = false;
  }

  /**
   * Inicializa el AudioContext. Debe llamarse tras una interacción del usuario.
   */
  init() {
    if (!this.audioContext) {
      // OpenAI gpt-realtime-translate usa 24kHz
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      console.log('[AudioPlayer] AudioContext inicializado a 24kHz.');
    } else if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  /**
   * Encola un chunk de PCM16 codificado en base64 para reproducir.
   * @param {string} base64Chunk
   */
  async enqueue(base64Chunk) {
    if (!this.audioContext) this.init();

    try {
      // 1. Decodificar base64 a cadena binaria
      const binary = atob(base64Chunk);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      // 2. PCM16 (Int16Array) -> Web Audio (Float32Array)
      const pcm16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        // Normalizar de 16 bits (-32768 a 32767) a rango de punto flotante (-1.0 a 1.0)
        float32[i] = pcm16[i] / 32768.0;
      }

      // 3. Crear AudioBuffer de 1 canal (mono), 24kHz
      const audioBuffer = this.audioContext.createBuffer(1, float32.length, 24000);
      audioBuffer.copyToChannel(float32, 0);

      // 4. Agregar a la cola
      this.queue.push(audioBuffer);

      // 5. Iniciar la reproducción si no hay nada sonando
      if (!this.playing) {
        this.playNext();
      }
    } catch (e) {
      console.error('[AudioPlayer] Error procesando chunk de audio:', e);
    }
  }

  /**
   * Reproduce el siguiente chunk en la cola de forma recursiva.
   */
  playNext() {
    if (this.queue.length === 0) {
      this.playing = false;
      return;
    }

    this.playing = true;
    const buffer = this.queue.shift();

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    // Cuando termina este chunk, desencadenar el siguiente
    source.onended = () => {
      this.playNext();
    };

    source.start();
  }

  /**
   * Detiene la reproducción y limpia la cola.
   */
  stop() {
    this.queue = [];
    this.playing = false;
    // Detener la fuente actual requeriría guardar referencia a `source`,
    // por simplicidad vaciamos la cola para que no sigan sonando los siguientes.
  }
}

// Instancia global para ser usada por main.js
window.globalAudioPlayer = new AudioPlayer();
