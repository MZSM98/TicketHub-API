# Contexto de build: la raíz del repo (ver docker-compose.yml).
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# Solo las dependencias de este servicio, usando el lockfile de la raíz (npm workspaces).
COPY package.json package-lock.json ./
COPY services/ticket/package.json services/ticket/
RUN npm ci --omit=dev --workspace services/ticket --include-workspace-root=false \
  && npm cache clean --force

COPY services/ticket/src services/ticket/src

USER node
WORKDIR /app/services/ticket
EXPOSE 3005
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3005/health > /dev/null || exit 1
CMD ["node", "src/index.js"]
