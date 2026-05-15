/**
 * audioCapture.js - CORREGIDO v1.1
 * Fix: usar onstop para emitir audio:end (no verificar state dentro de ondataavailable)
 * Fix: timeslice de 250ms para streaming progresivo
 * Fix: umbral de chunk reducido a 100 bytes (el threshold de 1000 era demasiado alto)
 */
let mediaRecorder = null;
let stream = null;
let sequenceNumber = 0;
let _pendingEnd = false; // flag para emitir audio:end en onstop

window.startAudioCapture = async function(role, roomId) {
  if (mediaRecorder && mediaRecorder.state === 'recording') return;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    mediaRecorder = new MediaRecorder(stream);
    sequenceNumber = 0;
    _pendingEnd = false;

    mediaRecorder.ondataavailable = async (e) => {
      // Umbral bajo: 100 bytes (el de 1000 descartaba audio válido corto)
      if (e.data.size < 100) return;

      const buffer = await e.data.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Data = btoa(binary);

      if (window.emitAudioChunk) {
        console.log(`[CLIENT] audio:chunk | seq=${sequenceNumber} bytes=${base64Data.length}`);
        window.emitAudioChunk(roomId, role, base64Data, sequenceNumber++);
      }
    };

    // ✅ FIX PRINCIPAL: audio:end va en onstop, no en ondataavailable
    mediaRecorder.onstop = () => {
      console.log('[AudioCapture] onstop → emitiendo audio:end seq=' + sequenceNumber);
      if (window.emitAudioEnd) {
        window.emitAudioEnd(roomId, role, sequenceNumber);
      }
    };

    // timeslice 250ms: envía chunks progresivos mientras grabas
    mediaRecorder.start(250);
    console.log('[AudioCapture] Grabación iniciada (PTT, timeslice=250ms)');

  } catch (err) {
    console.error('[AudioCapture] Error micrófono:', err);
    throw err;
  }
};

window.stopAudioCapture = function(role, roomId) {
  let wasRecording = false;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop(); // dispara onstop → emite audio:end
    wasRecording = true;
    console.log('[AudioCapture] Grabación detenida.');
  }
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  mediaRecorder = null;
  return wasRecording;
};
