// Llamadas /internal a otros servicios (X-Internal-Token). Cada una tiene timeout para que un
// servicio caído no deje colgada la petición (RNF-03).
import { config } from './config.js';
import { serviceUnavailable } from './http.js';

/** GET interno; regresa { status, body } o null si el servicio no responde. */
async function internalGet(service, path) {
  try {
    const res = await fetch(`${config.services[service]}/api/v1${path}`, {
      headers: { 'x-internal-token': config.internalToken },
      signal: AbortSignal.timeout(config.internalTimeoutMs),
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

/** Usuario de IdentityService `GET /internal/users/{userId}`, null si no existe. 503 si no responde. */
export async function getUser(userId) {
  const result = await internalGet('identity', `/internal/users/${userId}`);
  if (result?.status === 404) return null;
  if (result?.status !== 200 || typeof result.body?.id !== 'number') throw serviceUnavailable();
  return result.body;
}

/** Número de zonas del evento en InventoryService `GET /internal/zones?eventId=`. 503 si no responde. */
export async function countZones(eventId) {
  const result = await internalGet('inventory', `/internal/zones?eventId=${eventId}`);
  if (result?.status !== 200 || !Array.isArray(result.body)) throw serviceUnavailable();
  return result.body.length;
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

/** UserStats de IdentityService, o null si no está disponible o la respuesta no es válida. */
export async function userStats() {
  const result = await internalGet('identity', '/internal/stats/users');
  const body = result?.status === 200 ? result.body : null;
  const roles = ['BUYER', 'STAFF', 'ORGANIZER', 'ADMIN'];
  if (
    !isCount(body?.total) ||
    !isCount(body.suspended) ||
    !roles.every((role) => isCount(body.byRole?.[role]))
  ) {
    return null;
  }
  return {
    total: body.total,
    byRole: Object.fromEntries(roles.map((role) => [role, body.byRole[role]])),
    suspended: body.suspended,
  };
}

/** SalesStats de PurchaseService, o null si no está disponible o la respuesta no es válida. */
export async function salesStats() {
  const result = await internalGet('purchase', '/internal/stats/sales');
  const body = result?.status === 200 ? result.body : null;
  if (
    !isCount(body?.purchases) ||
    !/^\d+\.\d{2}$/.test(body.grossRevenue ?? '') ||
    body.currency !== 'MXN'
  ) {
    return null;
  }
  return { purchases: body.purchases, grossRevenue: body.grossRevenue, currency: body.currency };
}
