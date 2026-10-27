import { serviceUnavailable } from '@tickethub/common/http';
import { config } from './config.js';

export async function getEvent(eventId) {
  let res;
  try {
    res = await fetch(`${config.services.catalog}/api/v1/internal/events/${eventId}`, {
      headers: { 'x-internal-token': config.internalToken },
      signal: AbortSignal.timeout(config.internalTimeoutMs),
    });
  } catch {
    throw serviceUnavailable();
  }
  if (res.status === 404) return null;
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || typeof body?.organizerId !== 'number') throw serviceUnavailable();
  return body;
}
