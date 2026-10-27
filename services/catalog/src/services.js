import { config } from './config.js';
import { serviceUnavailable } from '@tickethub/common/http';

async function internalRequest(service, path, method = 'GET') {
  try {
    const res = await fetch(`${config.services[service]}/api/v1${path}`, {
      method,
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

export async function deleteZones(eventId) {
  const result = await internalRequest('inventory', `/internal/events/${eventId}/zones`, 'DELETE');
  if (result?.status !== 204) throw serviceUnavailable();
}

export async function getUser(userId) {
  const result = await internalRequest('identity', `/internal/users/${userId}`);
  if (result?.status === 404) return null;
  if (result?.status !== 200 || typeof result.body?.id !== 'number') throw serviceUnavailable();
  return result.body;
}

export async function countZones(eventId) {
  const result = await internalRequest('inventory', `/internal/zones?eventId=${eventId}`);
  if (result?.status !== 200 || !Array.isArray(result.body)) throw serviceUnavailable();
  return result.body.length;
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

export async function userStats() {
  const result = await internalRequest('identity', '/internal/stats/users');
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

export async function salesStats() {
  const result = await internalRequest('purchase', '/internal/stats/sales');
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
