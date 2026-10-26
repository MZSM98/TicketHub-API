// InventoryService y PurchaseService falsos para las pruebas de CatalogService. Solo responden lo
// que Catalog les pide (inventory.yaml GET /internal/zones, purchase.yaml GET /internal/stats/sales)
// y registran el X-Internal-Token recibido. docker-compose.test.yml apunta Catalog a este servidor.
import http from 'node:http';

export const fakes = {
  zonesByEvent: new Map(),
  inventoryUp: true,
  sales: { purchases: 3, grossRevenue: '4500.00', currency: 'MXN' },
  salesUp: true,
  tokens: [],
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startFakes(port, internalToken) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fakes');
    fakes.tokens.push(req.headers['x-internal-token']);
    if (req.headers['x-internal-token'] !== internalToken) {
      return send(res, 401, { code: 'UNAUTHORIZED', message: 'Token interno inválido' });
    }
    if (url.pathname === '/api/v1/internal/zones') {
      if (!fakes.inventoryUp) return send(res, 500, { code: 'INTERNAL_ERROR', message: 'x' });
      const eventId = Number(url.searchParams.get('eventId'));
      const count = fakes.zonesByEvent.get(eventId) ?? 0;
      const zones = Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        eventId,
        name: `Zona ${i + 1}`,
        type: 'GENERAL',
        price: '100.00',
        currency: 'MXN',
        capacity: 100,
        reservedCount: 0,
        soldCount: 0,
      }));
      return send(res, 200, zones);
    }
    if (url.pathname === '/api/v1/internal/stats/sales') {
      if (!fakes.salesUp) return send(res, 503, { code: 'SERVICE_UNAVAILABLE', message: 'x' });
      return send(res, 200, fakes.sales);
    }
    return send(res, 404, { code: 'NOT_FOUND', message: 'Recurso no encontrado' });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
