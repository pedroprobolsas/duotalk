#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-manual.sh — Despliegue rápido de DuoTalk desde el VPS
# Uso: bash deploy-manual.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo "🔄 [1/5] Bajando último código desde GitHub..."
git fetch origin main
git reset --hard origin/main

echo "🔨 [2/5] Construyendo imagen Docker SIN caché..."
docker build --no-cache -t ghcr.io/pedroprobolsas/duotalk:latest .

echo "📦 [3/5] Redesplegando stack..."
docker stack deploy -c stack-duotalk.yml duotalk --with-registry-auth

echo "🚀 [4/5] Forzando actualización del servicio..."
docker service update \
  --image ghcr.io/pedroprobolsas/duotalk:latest \
  --force \
  duotalk_server

echo "🧹 [5/5] Limpiando imágenes huérfanas..."
docker image prune -f

echo ""
echo "✅ Deploy completado. Verificando..."
docker service ps duotalk_server --no-trunc | head -5
