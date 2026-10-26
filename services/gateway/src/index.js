import http from 'node:http';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { resolveService } from './routes.js';

const API_PREFIX = '/api/v1';
const port = Number(process.env.PORT ?? 8080);
// Sin respuesta del servicio en este tiempo, el gateway responde 503.
const PROXY_TIMEOUT_MS = 10_000;
// El timeout del agente también cubre la conexión TCP; proxyTimeout solo cuenta ya conectado.
const proxyAgent = new http.Agent({ keepAlive: true, timeout: PROXY_TIMEOUT_MS });

const serviceUrls = {
  identity: process.env.IDENTITY_SERVICE_URL ?? 'http://identity-service:3001',
  catalog: process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3002',
  inventory: process.env.INVENTORY_SERVICE_URL ?? 'http://inventory-service:3003',
  purchase: process.env.PURCHASE_SERVICE_URL ?? 'http://purchase-service:3004',
  ticket: process.env.TICKET_SERVICE_URL ?? 'http://ticket-service:3005',
};

const app = express();
app.disable('x-powered-by');

async function serviceStatus(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? 'UP' : 'DOWN';
  } catch {
    return 'DOWN';
  }
}

async function health(_req, res) {
  const names = Object.keys(serviceUrls);
  const statuses = await Promise.all(names.map((name) => serviceStatus(serviceUrls[name])));
  const services = Object.fromEntries(names.map((name, i) => [name, statuses[i]]));
  res.json({ status: 'UP', services });
}

app.get('/health', health);
app.get(`${API_PREFIX}/health`, health);

function sendError(res, status, code, message) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code, message }));
}

// Un proxy por servicio. La ruta llega intacta (/api/v1/...) al servicio, como en los contratos.
const proxies = Object.fromEntries(
  Object.entries(serviceUrls).map(([name, target]) => [
    name,
    createProxyMiddleware({
      target,
      changeOrigin: true,
      agent: proxyAgent,
      proxyTimeout: PROXY_TIMEOUT_MS,
      on: {
        // Si un servicio está caído solo fallan sus rutas (RNF-03).
        error: (_err, _req, res) => {
          if (typeof res.writeHead !== 'function') return res.destroy();
          sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Servicio temporalmente inactivo');
        },
      },
    }),
  ]),
);

app.use(API_PREFIX, (req, res, next) => {
  const service = resolveService(req.path);
  if (!service) return next();
  // Express quita el prefijo de req.url al montar; se restaura para reenviar la ruta completa.
  req.url = req.originalUrl;
  return proxies[service](req, res, next);
});

app.use((_req, res) => sendError(res, 404, 'NOT_FOUND', 'Recurso no encontrado'));

const server = app.listen(port, () => {
  console.log(`gateway escuchando en el puerto ${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
