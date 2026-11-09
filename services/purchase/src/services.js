import { serviceUnavailable } from '@tickethub/common/http';
import { config } from './config.js';

async function internalCall(base, path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        'x-internal-token': config.internalToken,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.internalTimeoutMs),
    });
  } catch {
    throw serviceUnavailable();
  }
  const text = await res.text().catch(() => '');
  return { status: res.status, body: parseJson(text) };
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const isReservation = (body) =>
  typeof body?.id === 'number' && typeof body?.status === 'string' && Array.isArray(body?.items);

export async function getReservation(reservationId) {
  const { status, body } = await internalCall(
    config.services.inventory,
    `/internal/reservations/${reservationId}`,
  );
  if (status === 404) return null;
  if (status !== 200 || !isReservation(body)) throw serviceUnavailable();
  return body;
}

export async function confirmSale(reservationId, purchaseId) {
  return internalCall(
    config.services.inventory,
    `/internal/reservations/${reservationId}/confirm-sale`,
    { method: 'POST', body: { purchaseId } },
  );
}

export async function revokeSale(reservationId, purchaseId) {
  const { status } = await internalCall(
    config.services.inventory,
    `/internal/reservations/${reservationId}/revoke-sale`,
    { method: 'POST', body: { purchaseId } },
  );
  return status === 200;
}

export async function releaseReservation(reservationId) {
  const { status } = await internalCall(
    config.services.inventory,
    `/internal/reservations/${reservationId}/release`,
    { method: 'POST' },
  );
  return status === 200;
}

export async function zonesOfEvent(eventId) {
  const { status, body } = await internalCall(
    config.services.inventory,
    `/internal/zones?eventId=${eventId}`,
  );
  if (status !== 200 || !Array.isArray(body)) throw serviceUnavailable();
  return body;
}

export async function getEvent(eventId) {
  const { status, body } = await internalCall(
    config.services.catalog,
    `/internal/events/${eventId}`,
  );
  if (status === 404) return null;
  if (status !== 200 || typeof body?.organizerId !== 'number') throw serviceUnavailable();
  return body;
}

export async function issueTickets(payload) {
  const { status, body } = await internalCall(config.services.ticket, '/internal/tickets/issue', {
    method: 'POST',
    body: payload,
  });
  if ((status !== 200 && status !== 201) || !Array.isArray(body?.ticketIds)) {
    throw new Error(`TicketService respondió ${status}`);
  }
  return body.ticketIds;
}
