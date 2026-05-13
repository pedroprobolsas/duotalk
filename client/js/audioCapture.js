/**
 * audioCapture.js
 * Captura audio del micrófono usando MediaRecorder y envía chunks a través de Socket.io.
 * El formato capturado en la mayoría de navegadores modernos es WebM/Opus,
 * que el servidor luego convertirá a PCM16 usando ffmpeg.
 */

let mediaRecorder = null;
let stream = null;
let sequenceNumber = 0;

/**
 * Solicita permisos e inicia la captura de audio.
 * @param {string} role El rol del usuario ('host' o 'guest')
 * @param {string} roomId El ID de la sala
 */
window.startAudioCapture = async function(role, roomId) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // Usar el formato nativo preferido por el navegador (normalmente audio/webm;codecs=opus)
    mediaRecorder = new MediaRecorder(stream);
    sequenceNumber = 0;

    mediaRecorder.ondataavailable = async (e) => {
      // Ignorar chunks muy pequeños
      if (e.data.size < 1000) return;

      // Convertir el Blob a base64 para enviar por socket
      const buffer = await e.data.arrayBuffer();
      // En el browser btoa requiere un string binario
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      // Procesar en lotes si es muy grande, pero para 250ms está bien directo
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Data = btoa(binary);

      // Emitir evento importado globalmente desde socket.js o usar una función puente
      if (window.emitAudioChunk) {
        window.emitAudioChunk(roomId, role, base64Data, sequenceNumber++);
      }
    };

    // Emitir chunks cada 250ms para baja latencia (flujo continuo)
    mediaRecorder.start(250);
    console.log('[AudioCapture] Grabación iniciada.');
  } catch (err) {
    console.error('[AudioCapture] Error al acceder al micrófono:', err);
    throw err;
  }
}

/**
 * Detiene la captura de audio y libera el micrófono.
 * @param {string} role El rol del usuario ('host' o 'guest')
 * @param {string} roomId El ID de la sala
 */
window.stopAudioCapture = function(role, roomId) {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    console.log('[AudioCapture] Grabación detenida.');
    
    // Emitir el final de este bloque de habla
    if (window.emitAudioEnd) {
      window.emitAudioEnd(roomId, role, sequenceNumber);
    }
  }

  // Detener pistas para liberar el led de grabación del navegador
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  
  mediaRecorder = null;
}
