# Contexto de build: la raíz del repo (ver docker-compose.yml).
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# Solo las dependencias de este servicio, usando el lockfile de la raíz (npm workspaces).
COPY package.json package-lock.json ./
COPY services/common/package.json services/common/
COPY services/inventory/package.json services/inventory/
RUN npm ci --omit=dev --workspace services/common --workspace services/inventory --include-workspace-root=false \
  && npm cache clean --force

COPY services/common/src services/common/src
COPY services/inventory/src services/inventory/src

USER node
WORKDIR /app/services/inventory
EXPOSE 3003
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3003/health > /dev/null || exit 1
CMD ["node", "src/index.js"]
