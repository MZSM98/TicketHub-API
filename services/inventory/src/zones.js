import { query } from '@tickethub/common/db';
import { HttpError, parseId } from '@tickethub/common/http';
import { getEvent } from './catalog.js';

export const CURRENCY = 'MXN';

export const eventNotFound = () => new HttpError(404, 'EVENT_NOT_FOUND', 'El evento no existe');
export const zoneNotFound = () => new HttpError(404, 'ZONE_NOT_FOUND', 'La zona no existe');
export const zoneNotNumbered = () =>
  new HttpError(409, 'ZONE_NOT_NUMBERED', 'La zona es general y no tiene asientos numerados');
export const zoneHasSales = () =>
  new HttpError(409, 'ZONE_HAS_SALES', 'La zona ya tiene asientos reservados o vendidos');
export const eventNotEditable = (status) =>
  new HttpError(409, 'INVALID_EVENT_STATE', 'El evento no se puede modificar en su estado actual', {
    status,
  });
export const eventNotAvailable = () =>
  new HttpError(410, 'EVENT_NOT_AVAILABLE', 'El evento ya no está disponible');
const notEventOwner = (eventId) =>
  new HttpError(403, 'NOT_EVENT_OWNER', 'Solo el organizador dueño del evento puede modificarlo', {
    eventId,
  });

export const ZONE_COLUMNS = 'id, event_id, name, type, price, capacity, reserved_count, sold_count';

export const toZone = (row) => ({
  id: row.id,
  eventId: row.event_id,
  name: row.name,
  type: row.type,
  price: row.price,
  currency: CURRENCY,
  capacity: row.capacity,
  reservedCount: row.reserved_count,
  soldCount: row.sold_count,
});

export async function findZone(zoneId, conn) {
  const [row] = await query(
    `SELECT ${ZONE_COLUMNS} FROM zones WHERE id = ?${conn ? ' FOR UPDATE' : ''}`,
    [zoneId],
    conn,
  );
  return row ?? null;
}

function checkOwner(req, event, allowAdmin) {
  if (allowAdmin && req.auth.role === 'ADMIN') return;
  if (event.organizerId !== req.auth.userId) throw notEventOwner(event.id);
}

export async function ownedEvent(req, { allowAdmin = false } = {}) {
  const eventId = parseId(req.params.eventId, eventNotFound);
  const event = await getEvent(eventId);
  if (!event) throw eventNotFound();
  checkOwner(req, event, allowAdmin);
  return event;
}

export async function ownedZone(req) {
  const zone = await findZone(parseId(req.params.zoneId, zoneNotFound));
  if (!zone) throw zoneNotFound();
  const event = await getEvent(zone.event_id);
  if (!event) throw zoneNotFound();
  checkOwner(req, event, false);
  return { zone, event };
}

export async function visibleEvent(eventId, hidden = eventNotFound) {
  const event = await getEvent(eventId);
  if (!event || event.status === 'DRAFT') throw hidden();
  if (event.status === 'CANCELLED' || new Date(event.startsAt).getTime() <= Date.now()) {
    throw eventNotAvailable();
  }
  return event;
}

export async function seatMap(zone) {
  const seats = await query(
    'SELECT id, row_label, seat_number, status FROM seats WHERE zone_id = ? ORDER BY id',
    [zone.id],
  );
  const rows = new Map();
  for (const seat of seats) {
    if (!rows.has(seat.row_label)) rows.set(seat.row_label, []);
    rows
      .get(seat.row_label)
      .push({ id: seat.id, seatNumber: seat.seat_number, status: seat.status });
  }
  return {
    zoneId: zone.id,
    eventId: zone.event_id,
    name: zone.name,
    price: zone.price,
    currency: CURRENCY,
    rows: [...rows].map(([rowLabel, list]) => ({
      rowLabel,
      seats: list.sort((a, b) => a.seatNumber - b.seatNumber),
    })),
  };
}
