# ── Stage 1: Instalar dependencias ───────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: Imagen de producción ────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Copiar dependencias instaladas
COPY --from=deps /app/node_modules ./node_modules

# Copiar código del servidor
COPY server/ ./

# Copiar frontend estático (servido por Express)
COPY client/ ./client/

# Crear directorio de sesiones (M9 — Fase 7)
RUN mkdir -p /home/duotalk/sessions

# Usuario no-root por seguridad
RUN addgroup -S duotalk && adduser -S duotalk -G duotalk
USER duotalk

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
