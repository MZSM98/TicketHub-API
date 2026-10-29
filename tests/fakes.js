import http from 'node:http';
import { INVENTORY } from './helpers.js';

const INVENTORY_ORIGIN = new URL(INVENTORY).origin;

export const fakes = {
  inventoryUp: true,
  sales: { purchases: 3, grossRevenue: '4500.00', currency: 'MXN' },
  salesUp: true,
  tokens: [],
  deletedZones: [],
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function proxyToInventory(req, res, url) {
  const upstream = await fetch(`${INVENTORY_ORIGIN}${url.pathname}${url.search}`, {
    method: req.method,
    headers: { 'x-internal-token': req.headers['x-internal-token'] },
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, text ? { 'content-type': 'application/json' } : {});
  res.end(text);
  return upstream.status;
}

export function startFakes(port, internalToken) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fakes');
    fakes.tokens.push(req.headers['x-internal-token']);
    if (req.headers['x-internal-token'] !== internalToken) {
      return send(res, 401, { code: 'UNAUTHORIZED', message: 'Token interno inválido' });
    }
    const zonesOfEvent = /^\/api\/v1\/internal\/events\/(\d+)\/zones$/.exec(url.pathname);
    if ((req.method === 'DELETE' && zonesOfEvent) || url.pathname === '/api/v1/internal/zones') {
      if (!fakes.inventoryUp) return send(res, 500, { code: 'INTERNAL_ERROR', message: 'x' });
      const status = await proxyToInventory(req, res, url);
      if (zonesOfEvent && status === 204) fakes.deletedZones.push(Number(zonesOfEvent[1]));
      return;
    }
    if (url.pathname === '/api/v1/internal/stats/sales') {
      if (!fakes.salesUp) return send(res, 503, { code: 'SERVICE_UNAVAILABLE', message: 'x' });
      return send(res, 200, fakes.sales);
    }
    return send(res, 404, { code: 'NOT_FOUND', message: 'Recurso no encontrado' });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
