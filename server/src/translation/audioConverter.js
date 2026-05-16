/**
 * audioConverter.js
 * Convierte audio WebM/Opus (formato nativo del browser) a PCM16 24kHz mono
 * usando ffmpeg — requerido por gpt-realtime-translate (skill §6).
 *
 * ffmpeg debe estar instalado en el contenedor Docker (ver Dockerfile).
 */

import { spawn } from 'child_process';

/**
 * @param {string} webmBase64  Audio en base64 (WebM/Opus del browser)
 * @returns {Promise<string>}  Audio en base64 (PCM16, 24kHz, mono)
 */
export function convertWebmToPcm16(webmBase64, mimeType = 'audio/webm') {
  return new Promise((resolve, reject) => {
    const inputBuffer = Buffer.from(webmBase64, 'base64');
    
    const ffmpegFormat = mimeType.includes('webm') ? 'webm' : 'mp4';

    // ffmpeg: WebM/Opus o mp4 → PCM16 little-endian, 24kHz, mono
    const ffmpeg = spawn('ffmpeg', [
      '-f',        ffmpegFormat, // Forzar formato explícito
      '-i',        'pipe:0',   // input desde stdin
      '-f',        's16le',    // PCM16 little-endian
      '-ar',       '24000',    // 24.000 Hz (requerido por OpenAI)
      '-ac',       '1',        // mono
      '-acodec',   'pcm_s16le',
      'pipe:1',                // output a stdout
    ]);

    const chunks = [];
    ffmpeg.stdout.on('data',  (chunk) => chunks.push(chunk));

    ffmpeg.stderr.on('data', (data) => {
      // Solo loggear si hay error real (no warnings)
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        console.error('[ffmpeg]', msg.trim());
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`ffmpeg no disponible: ${err.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg falló con código ${code}`));
      } else {
        const pcmBuffer = Buffer.concat(chunks);
        if (pcmBuffer.length === 0) {
          reject(new Error('ffmpeg produjo 0 bytes de PCM'));
        } else {
          resolve(pcmBuffer.toString('base64'));
        }
      }
    });

    ffmpeg.stdin.write(inputBuffer);
    ffmpeg.stdin.end();
  });
}
