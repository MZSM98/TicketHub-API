import http from 'node:http';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import jwt from 'jsonwebtoken';
import { authMode, resolveService } from './routes.js';
import { rewriteForwarded } from './forwarded.js';
import { parseTrustedProxies } from './trust.js';
import { checkJwtSecret, checkSecret } from './secret.js';

const API_PREFIX = '/api/v1';
const port = Number(process.env.PORT ?? 8080);
const jwtSecret = checkJwtSecret(process.env.JWT_SECRET);
const forwardSecret = checkSecret('GATEWAY_FORWARD_SECRET', process.env.GATEWAY_FORWARD_SECRET);
const isTrustedProxy = parseTrustedProxies(process.env.TRUST_PROXY);
const SERVICES_WITH_FORWARD_SECRET = new Set(['catalog']);
// Sin respuesta del servicio en este tiempo, el gateway responde 503.
const PROXY_TIMEOUT_MS = 15_000;
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

/**
 * Revisa firma y expiración del access token (common.yaml bearerAuth). Los roles y la propiedad
 * de los recursos los revisa cada servicio; el header Authorization se reenvía sin cambios.
 */
function hasValidToken(req) {
  const match = /^Bearer (.+)$/i.exec(req.get('authorization') ?? '');
  if (!match) return false;
  try {
    jwt.verify(match[1], jwtSecret, { algorithms: ['HS256'] });
    return true;
  } catch {
    return false;
  }
}

app.use(API_PREFIX, (req, res, next) => {
  const service = resolveService(req.path);
  if (!service) return next();
  const mode = authMode(req.method, req.path);
  const tokenSent = req.get('authorization') !== undefined;
  if ((mode === 'required' || (mode === 'optional' && tokenSent)) && !hasValidToken(req)) {
    return sendError(
      res,
      401,
      'UNAUTHORIZED',
      'Sesión no válida o expirada, inicie sesión de nuevo',
    );
  }
  // Express quita el prefijo de req.url al montar; se restaura para reenviar la ruta completa.
  req.url = req.originalUrl;
  rewriteForwarded(req, {
    secret: forwardSecret,
    sendSecret: SERVICES_WITH_FORWARD_SECRET.has(service),
    isTrustedProxy,
  });
  return proxies[service](req, res, next);
});

app.use((_req, res) => sendError(res, 404, 'NOT_FOUND', 'Recurso no encontrado'));

const server = app.listen(port, () => {
  console.log(`gateway escuchando en el puerto ${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
