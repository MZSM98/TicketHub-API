import { Router } from 'express';
import { query, transaction } from '@tickethub/common/db';
import { authenticate, HttpError, parseId, requireRole, validate } from '@tickethub/common/http';
import { expireDue } from '../reservations.js';
import {
  eventNotEditable,
  findZone,
  ownedEvent,
  ownedZone,
  seatMap,
  toZone,
  visibleEvent,
  eventNotFound,
  ZONE_COLUMNS,
  zoneHasSales,
  zoneNotFound,
  zoneNotNumbered,
} from '../zones.js';

export const router = Router();
const organizer = [authenticate, requireRole('ORGANIZER')];

const ZONE_RULES = {
  name: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 80 },
  type: { type: 'string', required: true, enum: ['NUMBERED', 'GENERAL'] },
  price: { type: 'string', required: true, pattern: /^\d{1,8}\.\d{2}$/ },
  capacity: { type: 'integer', required: true, minimum: 1, maximum: 100000 },
};

const SEAT_INSERT_CHUNK = 1000;

router.get('/events/:eventId/availability', async (req, res) => {
  const event = await visibleEvent(parseId(req.params.eventId, eventNotFound));
  await expireDue();
  const rows = await query(`SELECT ${ZONE_COLUMNS} FROM zones WHERE event_id = ? ORDER BY id`, [
    event.id,
  ]);
  const zones = rows.map((row) => {
    const available = row.capacity - row.reserved_count - row.sold_count;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      price: row.price,
      currency: 'MXN',
      capacity: row.capacity,
      available,
      soldOut: available === 0,
    };
  });
  res.json({
    eventId: event.id,
    soldOut: zones.length > 0 && zones.every((zone) => zone.soldOut),
    zones,
  });
});

router.get(
  '/events/:eventId/zones',
  authenticate,
  requireRole('ORGANIZER', 'ADMIN'),
  async (req, res) => {
    const event = await ownedEvent(req, { allowAdmin: true });
    const rows = await query(`SELECT ${ZONE_COLUMNS} FROM zones WHERE event_id = ? ORDER BY id`, [
      event.id,
    ]);
    res.json(rows.map(toZone));
  },
);

router.post('/events/:eventId/zones', ...organizer, async (req, res) => {
  const event = await ownedEvent(req);
  if (event.status === 'CANCELLED') throw eventNotEditable(event.status);
  const body = validate(req.body, ZONE_RULES);
  const result = await query(
    'INSERT INTO zones (event_id, name, type, price, capacity) VALUES (?, ?, ?, ?, ?)',
    [event.id, body.name, body.type, body.price, body.capacity],
  );
  res.status(201).json(toZone(await findZone(result.insertId)));
});

router.put('/zones/:zoneId', ...organizer, async (req, res) => {
  const { zone, event } = await ownedZone(req);
  if (event.status === 'CANCELLED') throw eventNotEditable(event.status);
  const body = validate(req.body, ZONE_RULES);
  const outcome = await transaction(async (conn) => {
    const current = await findZone(zone.id, conn);
    if (!current) return zoneNotFound();
    if (body.type !== current.type) {
      return new HttpError(409, 'ZONE_TYPE_CHANGE', 'El tipo de la zona no se puede cambiar', {
        type: current.type,
      });
    }
    const committed = current.reserved_count + current.sold_count;
    if (body.capacity < committed) {
      return new HttpError(
        409,
        'CAPACITY_BELOW_COMMITTED',
        'La capacidad no puede ser menor a los boletos reservados o vendidos',
        { committed },
      );
    }
    if (current.type === 'NUMBERED' && body.capacity !== current.capacity) {
      if (committed > 0) return zoneHasSales();
      await query('DELETE FROM seats WHERE zone_id = ?', [zone.id], conn);
    }
    await query(
      'UPDATE zones SET name = ?, price = ?, capacity = ? WHERE id = ?',
      [body.name, body.price, body.capacity, zone.id],
      conn,
    );
    return null;
  });
  if (outcome) throw outcome;
  res.json(toZone(await findZone(zone.id)));
});

router.delete('/zones/:zoneId', ...organizer, async (req, res) => {
  const { zone } = await ownedZone(req);
  const outcome = await transaction(async (conn) => {
    const current = await findZone(zone.id, conn);
    if (!current) return zoneNotFound();
    if (current.reserved_count + current.sold_count > 0) return zoneHasSales();
    await query('DELETE FROM zones WHERE id = ?', [zone.id], conn);
    return null;
  });
  if (outcome) throw outcome;
  res.status(204).end();
});

router.get('/zones/:zoneId/seats', async (req, res) => {
  const zone = await findZone(parseId(req.params.zoneId, zoneNotFound));
  if (!zone) throw zoneNotFound();
  await visibleEvent(zone.event_id, zoneNotFound);
  if (zone.type !== 'NUMBERED') throw zoneNotNumbered();
  await expireDue();
  res.json(await seatMap(zone));
});

function parseLayout(body) {
  const fields = [];
  if (body === null || typeof body !== 'object' || !Array.isArray(body.rows)) {
    fields.push({ field: 'rows', issue: body?.rows === undefined ? 'required' : 'invalid_type' });
  } else if (body.rows.length === 0) {
    fields.push({ field: 'rows', issue: 'too_short' });
  } else {
    const labels = new Set();
    body.rows.forEach((row, i) => {
      const label = typeof row?.rowLabel === 'string' ? row.rowLabel.trim() : null;
      if (!label || label.length > 10)
        fields.push({ field: `rows[${i}].rowLabel`, issue: 'invalid_value' });
      else if (labels.has(label)) fields.push({ field: `rows[${i}].rowLabel`, issue: 'duplicate' });
      else labels.add(label);
      const count = row?.seatCount;
      if (!Number.isInteger(count) || count < 1 || count > 500) {
        fields.push({ field: `rows[${i}].seatCount`, issue: 'invalid_value' });
      }
    });
  }
  if (fields.length > 0) {
    const onlyMissing = fields.every((f) => f.issue === 'required');
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      onlyMissing
        ? 'Por favor llene todos los campos requeridos'
        : 'Algunos datos no son válidos, revise los campos marcados',
      { fields },
    );
  }
  return body.rows.map((row) => ({ rowLabel: row.rowLabel.trim(), seatCount: row.seatCount }));
}

router.post('/zones/:zoneId/seats', ...organizer, async (req, res) => {
  const { zone, event } = await ownedZone(req);
  if (event.status === 'CANCELLED') throw eventNotEditable(event.status);
  if (zone.type !== 'NUMBERED') throw zoneNotNumbered();
  const rows = parseLayout(req.body);
  const total = rows.reduce((sum, row) => sum + row.seatCount, 0);
  const outcome = await transaction(async (conn) => {
    const current = await findZone(zone.id, conn);
    if (!current) return zoneNotFound();
    if (current.reserved_count + current.sold_count > 0) return zoneHasSales();
    if (total !== current.capacity) {
      return new HttpError(
        400,
        'SEAT_COUNT_MISMATCH',
        'El total de asientos debe ser igual a la capacidad de la zona',
        { capacity: current.capacity, seats: total },
      );
    }
    await query('DELETE FROM seats WHERE zone_id = ?', [zone.id], conn);
    const values = rows.flatMap((row) =>
      Array.from({ length: row.seatCount }, (_, i) => [zone.id, row.rowLabel, i + 1]),
    );
    for (let i = 0; i < values.length; i += SEAT_INSERT_CHUNK) {
      const chunk = values.slice(i, i + SEAT_INSERT_CHUNK);
      await query(
        `INSERT INTO seats (zone_id, row_label, seat_number) VALUES ${chunk.map(() => '(?, ?, ?)').join(',')}`,
        chunk.flat(),
        conn,
      );
    }
    return null;
  });
  if (outcome) throw outcome;
  res.status(201).json(await seatMap(zone));
});
