/**
 * audioConverter.js
 * Convierte audio WebM/Opus (formato nativo del browser) a PCM16 24kHz mono
 * usando ffmpeg — requerido por gpt-realtime-translate (skill §6).
 *
 * ffmpeg debe estar instalado en el contenedor Docker (ver Dockerfile).
 */

import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';

/**
 * @param {string} webmBase64  Audio en base64 (WebM/Opus del browser)
 * @returns {Promise<string>}  Audio en base64 (PCM16, 24kHz, mono)
 */
export async function convertWebmToPcm16(webmBase64, mimeType = 'audio/webm') {
  const inputBuffer = Buffer.from(webmBase64, 'base64');
  const ext = mimeType.includes('webm') ? 'webm' : 'mp4';
  const tempId = randomUUID();
  const inputPath = path.join(os.tmpdir(), `${tempId}.${ext}`);
  
  try {
    await writeFile(inputPath, inputBuffer);

    return await new Promise((resolve, reject) => {
      // ffmpeg: temp file → PCM16 little-endian, 24kHz, mono (stdout)
      const ffmpeg = spawn('ffmpeg', [
        '-i',        inputPath,
        '-f',        's16le',
        '-ar',       '24000',
        '-ac',       '1',
        '-acodec',   'pcm_s16le',
        'pipe:1',
      ]);

      const chunks = [];
      let errorLog = '';

      ffmpeg.stdout.on('data',  (chunk) => chunks.push(chunk));
      ffmpeg.stderr.on('data',  (data) => { errorLog += data.toString(); });

      // Timeout de seguridad de 10 segundos
      const timeout = setTimeout(() => {
        ffmpeg.kill('SIGKILL');
        reject(new Error('ffmpeg timeout after 10s'));
      }, 10000);

      ffmpeg.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          console.error(`[ffmpeg error log]:`, errorLog);
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
    });
  } finally {
    // Limpieza
    unlink(inputPath).catch(() => {});
  }
}
