import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { roomManager } from './rooms/roomManager.js';
import { registerSocketHandlers } from './sockets/socketHandlers.js';
import cron from 'node-cron';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// ── Frontend estático ─────────────────────────────────────────────────────
// El Dockerfile copia client/ en /app/client
const clientDir = join(__dirname, '..', 'client');
app.use(express.static(clientDir));

// ── API endpoints ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    uptime:    process.uptime(),
    rooms:     roomManager.rooms.size,
    env:       process.env.NODE_ENV || 'development',
  });
});

// Diagnóstico de sala (útil para QA — solo en development)
app.get('/api/rooms/:id', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  const room = roomManager.getRoom(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    id:          room.id,
    status:      room.status,
    hostLang:    room.hostLang,
    guestLang:   room.guestLang,
    createdAt:   room.createdAt,
    lastActivity: room.lastActivity,
    transcript:  room.transcript.length,
  });
});

// SPA fallback — todas las rutas desconocidas sirven index.html
app.get('*', (_req, res) => {
  res.sendFile(join(clientDir, 'index.html'));
});

// ── HTTP + Socket.io ──────────────────────────────────────────────────────
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors:               { origin: '*' },
  maxHttpBufferSize:  10 * 1024 * 1024, // 10 MB — chunks de audio
  pingTimeout:        20_000,
  pingInterval:       10_000,
});

registerSocketHandlers(io, roomManager);

// ── Cron: limpiar salas expiradas cada 5 minutos ──────────────────────────
cron.schedule('*/5 * * * *', () => {
  const cleaned = roomManager.cleanExpiredRooms();
  if (cleaned > 0) console.log(`[CRON] Salas limpiadas: ${cleaned}`);
});

// ── Arrancar ──────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`✅ DuoTalk server  →  port ${PORT}`);
  console.log(`   NODE_ENV       →  ${process.env.NODE_ENV || 'development'}`);
  console.log(`   OPENAI key     →  ${process.env.OPENAI_API_KEY ? '✓ presente' : '✗ FALTA'}`);
  console.log(`   ANTHROPIC key  →  ${process.env.ANTHROPIC_API_KEY ? '✓ presente' : '✗ FALTA (Fase 7)'}`);
});
