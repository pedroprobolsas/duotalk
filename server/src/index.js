import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { roomManager } from './rooms/roomManager.js';
import { registerSocketHandlers } from './sockets/socketHandlers.js';
import cron from 'node-cron';

const PORT = process.env.PORT || 3000;
const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// Sirve el frontend estático desde /public
app.use(express.static(new URL('../../client', import.meta.url).pathname));

// Health check para Traefik / uptime monitors
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── HTTP + Socket.io ──────────────────────────────────────────────────────────
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10 * 1024 * 1024, // 10 MB — chunks de audio
});

registerSocketHandlers(io, roomManager);

// ── Cron: limpiar salas expiradas cada 5 minutos ──────────────────────────────
cron.schedule('*/5 * * * *', () => {
  const cleaned = roomManager.cleanExpiredRooms();
  if (cleaned > 0) console.log(`[CRON] Salas limpiadas: ${cleaned}`);
});

// ── Arrancar servidor ─────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`✅ DuoTalk server running on port ${PORT}`);
  console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
});
