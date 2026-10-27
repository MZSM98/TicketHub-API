import { Router } from 'express';
import {
  authenticate,
  forbidden,
  HttpError,
  parseId,
  requireRole,
  validate,
} from '@tickethub/common/http';
import { config } from '../config.js';
import {
  activeReservationExists,
  activeReservationOf,
  cancelAction,
  createReservation,
  expireDue,
  reservationNotFound,
  withReservation,
} from '../reservations.js';
import { visibleEvent } from '../zones.js';

export const router = Router();
const buyer = [authenticate, requireRole('BUYER')];

const isId = (value) => Number.isSafeInteger(value) && value >= 1;

function parseItems(raw) {
  if (raw === undefined || raw === null) return [{ field: 'items', issue: 'required' }];
  if (!Array.isArray(raw)) return [{ field: 'items', issue: 'invalid_type' }];
  if (raw.length === 0) return [{ field: 'items', issue: 'too_short' }];
  const fields = [];
  const seen = new Set();
  raw.forEach((item, i) => {
    const keys = item && typeof item === 'object' ? Object.keys(item).sort().join(',') : '';
    let key;
    if (keys === 'seatId' && isId(item.seatId)) key = `seat:${item.seatId}`;
    else if (
      keys === 'quantity,zoneId' &&
      isId(item.zoneId) &&
      Number.isSafeInteger(item.quantity) &&
      item.quantity >= 1
    ) {
      key = `zone:${item.zoneId}`;
    } else return fields.push({ field: `items[${i}]`, issue: 'invalid_value' });
    if (seen.has(key)) fields.push({ field: `items[${i}]`, issue: 'duplicate' });
    seen.add(key);
  });
  return fields;
}

router.post('/reservations', ...buyer, async (req, res) => {
  const fields = parseItems(req.body?.items);
  let body;
  try {
    body = validate(req.body, { eventId: { type: 'id', required: true } });
  } catch (err) {
    err.details.fields.push(...fields);
    throw err;
  }
  if (fields.length > 0) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      fields.every((f) => f.issue === 'required')
        ? 'Por favor llene todos los campos requeridos'
        : 'Algunos datos no son válidos, revise los campos marcados',
      { fields },
    );
  }
  const items = req.body.items.map((item) =>
    item.seatId !== undefined
      ? { seatId: item.seatId }
      : { zoneId: item.zoneId, quantity: item.quantity },
  );
  const tickets = items.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
  const max = config.maxTicketsPerReservation;
  if (tickets > max) {
    throw new HttpError(400, 'TOO_MANY_TICKETS', `Solo puede reservar hasta ${max} boletos`, {
      max,
    });
  }
  await visibleEvent(body.eventId);
  await expireDue();
  const active = await activeReservationOf(req.auth.userId);
  if (active) throw activeReservationExists(active.id);
  res.status(201).json(await createReservation(req.auth.userId, body.eventId, items));
});

router.get('/reservations/active', ...buyer, async (req, res) => {
  const reservation = await activeReservationOf(req.auth.userId);
  if (!reservation) {
    throw new HttpError(404, 'NO_ACTIVE_RESERVATION', 'No tiene una reserva activa');
  }
  res.json(reservation);
});

const ownerCheck =
  (userId, action = () => null) =>
  (row, conn) =>
    row.user_id === userId ? action(row, conn) : forbidden();

router.get('/reservations/:reservationId', ...buyer, async (req, res) => {
  const id = parseId(req.params.reservationId, reservationNotFound);
  res.json(await withReservation(id, ownerCheck(req.auth.userId)));
});

router.post('/reservations/:reservationId/cancel', ...buyer, async (req, res) => {
  const id = parseId(req.params.reservationId, reservationNotFound);
  res.json(await withReservation(id, ownerCheck(req.auth.userId, cancelAction)));
});
