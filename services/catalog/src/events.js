import { publicBaseUrl } from '@tickethub/common/public-url';
import { config } from './config.js';
import { query } from '@tickethub/common/db';
import { HttpError, parseId } from '@tickethub/common/http';

export const CATEGORIES = ['CONCERT', 'RECITAL', 'FESTIVAL', 'THEATER', 'SPORTS', 'OTHER'];
export const STATUSES = ['DRAFT', 'PUBLISHED', 'CANCELLED'];

export const eventNotFound = () => new HttpError(404, 'EVENT_NOT_FOUND', 'El evento no existe');
export const venueNotFound = () => new HttpError(404, 'VENUE_NOT_FOUND', 'El recinto no existe');
export const notEventOwner = (eventId) =>
  new HttpError(403, 'NOT_EVENT_OWNER', 'Solo el organizador dueño del evento puede modificarlo', {
    eventId,
  });
export const invalidEventState = (status) =>
  new HttpError(409, 'INVALID_EVENT_STATE', 'El evento no se puede modificar en su estado actual', {
    status,
  });

const iso = (date) => date.toISOString().replace('.000Z', 'Z');

export const toSeconds = (date) => new Date(Math.floor(date.getTime() / 1000) * 1000);

export const likeContains = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const VENUE_COLUMNS = 'id, name, address, city';

export const toVenue = (row) => ({
  id: row.id,
  name: row.name,
  address: row.address,
  city: row.city,
});

export const EVENT_SELECT = `SELECT e.id, e.organizer_id, e.title, e.description, e.category,
  e.starts_at, e.poster_key, e.status, e.created_at, e.updated_at,
  v.id AS venue_id, v.name AS venue_name, v.address AS venue_address, v.city AS venue_city
  FROM events e JOIN venues v ON v.id = e.venue_id`;

export const publicBase = (req) =>
  publicBaseUrl(req.headers, {
    fallback: config.publicBaseUrl,
    gatewaySecret: config.gatewaySecret,
    allowedHosts: config.allowedHosts,
  });

export function toEvent(row, baseUrl = config.publicBaseUrl) {
  return {
    id: row.id,
    organizerId: row.organizer_id,
    title: row.title,
    description: row.description,
    category: row.category,
    startsAt: iso(row.starts_at),
    status: row.status,
    posterUrl: row.poster_key ? `${baseUrl}/events/${row.id}/poster` : null,
    venue: {
      id: row.venue_id,
      name: row.venue_name,
      address: row.venue_address,
      city: row.venue_city,
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function findEventRow(eventId) {
  const [row] = await query(`${EVENT_SELECT} WHERE e.id = ?`, [eventId]);
  return row ?? null;
}

export async function ownedEvent(req) {
  const eventId = parseId(req.params.eventId, eventNotFound);
  const row = await findEventRow(eventId);
  if (!row) throw eventNotFound();
  if (row.organizer_id !== req.auth.userId) throw notEventOwner(eventId);
  return row;
}

export async function visibleEvent(req) {
  const eventId = parseId(req.params.eventId, eventNotFound);
  const row = await findEventRow(eventId);
  if (!row) throw eventNotFound();
  const { auth } = req;
  const privileged =
    auth?.role === 'ADMIN' || (auth?.role === 'ORGANIZER' && auth.userId === row.organizer_id);
  if (!privileged && row.status === 'DRAFT') throw eventNotFound();
  if (!privileged && row.status === 'CANCELLED') {
    throw new HttpError(410, 'EVENT_CANCELLED', 'El evento ya no está disponible');
  }
  return row;
}

export const isRowReferenced = (err) => err?.errno === 1451;
export const isMissingParent = (err) => err?.errno === 1452;
