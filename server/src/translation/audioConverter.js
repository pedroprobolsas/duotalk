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
export function convertWebmToPcm16(webmBase64) {
  return new Promise((resolve, reject) => {
    const inputBuffer = Buffer.from(webmBase64, 'base64');

    // ffmpeg: WebM/Opus → PCM16 little-endian, 24kHz, mono
    const ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'error',    // silenciar logs verbosos
      '-i',        'pipe:0',   // input desde stdin
      '-f',        's16le',    // PCM16 little-endian
      '-ar',       '24000',    // 24.000 Hz (requerido por OpenAI)
      '-ac',       '1',        // mono
      'pipe:1',                // output a stdout
    ]);

    const chunks = [];
    ffmpeg.stdout.on('data',  (chunk) => chunks.push(chunk));
    ffmpeg.stdout.on('end',   ()      => {
      const pcmBuffer = Buffer.concat(chunks);
      if (pcmBuffer.length === 0) {
        return reject(new Error('ffmpeg produjo 0 bytes de PCM'));
      }
      resolve(pcmBuffer.toString('base64'));
    });

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

    ffmpeg.stdin.write(inputBuffer);
    ffmpeg.stdin.end();
  });
}
