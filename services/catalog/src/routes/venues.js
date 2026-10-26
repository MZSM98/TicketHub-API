import { Router } from 'express';
import { query } from '../db.js';
import {
  authenticate,
  HttpError,
  PAGE_RULES,
  pageOf,
  parseId,
  parseQuery,
  requireRole,
  validate,
} from '../http.js';
import { isRowReferenced, likeContains, toVenue, VENUE_COLUMNS, venueNotFound } from '../events.js';

export const router = Router();
const organizerOrAdmin = [authenticate, requireRole('ORGANIZER', 'ADMIN')];

const VENUE_RULES = {
  name: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 160 },
  address: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 255 },
  city: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 120 },
};

async function findVenue(venueId) {
  const [row] = await query(`SELECT ${VENUE_COLUMNS} FROM venues WHERE id = ?`, [venueId]);
  if (!row) throw venueNotFound();
  return toVenue(row);
}

router.get('/venues', ...organizerOrAdmin, async (req, res) => {
  const q = parseQuery(req.query, { city: {}, q: {}, ...PAGE_RULES });
  const conditions = ['TRUE'];
  const params = [];
  if (q.city) {
    conditions.push('city = ?');
    params.push(q.city);
  }
  if (q.q) {
    conditions.push('name LIKE ?');
    params.push(likeContains(q.q));
  }
  const where = conditions.join(' AND ');
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM venues WHERE ${where}`, params);
  const rows = await query(
    `SELECT ${VENUE_COLUMNS} FROM venues WHERE ${where}
     ORDER BY name, id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
    params,
  );
  res.json(pageOf(rows.map(toVenue), total, q));
});

router.post('/venues', ...organizerOrAdmin, async (req, res) => {
  const body = validate(req.body, VENUE_RULES);
  const result = await query('INSERT INTO venues (name, address, city) VALUES (?, ?, ?)', [
    body.name,
    body.address,
    body.city,
  ]);
  res.status(201).json(await findVenue(result.insertId));
});

router.get('/venues/:venueId', ...organizerOrAdmin, async (req, res) => {
  res.json(await findVenue(parseId(req.params.venueId, venueNotFound)));
});

router.put('/venues/:venueId', ...organizerOrAdmin, async (req, res) => {
  const venueId = parseId(req.params.venueId, venueNotFound);
  const body = validate(req.body, VENUE_RULES);
  await query('UPDATE venues SET name = ?, address = ?, city = ? WHERE id = ?', [
    body.name,
    body.address,
    body.city,
    venueId,
  ]);
  res.json(await findVenue(venueId));
});

router.delete('/venues/:venueId', authenticate, requireRole('ADMIN'), async (req, res) => {
  const venueId = parseId(req.params.venueId, venueNotFound);
  let result;
  try {
    result = await query('DELETE FROM venues WHERE id = ?', [venueId]);
  } catch (err) {
    if (isRowReferenced(err)) {
      throw new HttpError(
        409,
        'VENUE_IN_USE',
        'El recinto tiene eventos asociados y no se puede eliminar',
      );
    }
    throw err;
  }
  if (result.affectedRows === 0) throw venueNotFound();
  res.status(204).end();
});
