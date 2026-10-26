import { Router } from 'express';
import { query } from '@tickethub/common/db';
import {
  authenticate,
  HttpError,
  optionalAuth,
  PAGE_RULES,
  pageOf,
  parseQuery,
  QUERY_ID_RULE,
  requireRole,
  serviceUnavailable,
  validate,
} from '@tickethub/common/http';
import {
  CATEGORIES,
  EVENT_SELECT,
  eventNotFound,
  findEventRow,
  invalidEventState,
  isMissingParent,
  likeContains,
  ownedEvent,
  STATUSES,
  toEvent,
  toSeconds,
  venueNotFound,
  visibleEvent,
} from '../events.js';
import { countZones } from '../services.js';

export const router = Router();
const organizer = [authenticate, requireRole('ORGANIZER')];

const EVENT_RULES = {
  venueId: { type: 'id', required: true },
  title: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 160 },
  description: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 5000 },
  category: { type: 'string', required: true, enum: CATEGORIES },
  startsAt: {
    type: 'date-time',
    required: true,
    future: true,
    messages: { not_in_future: 'La fecha del evento debe ser futura' },
  },
};

const TRANSITIONS = { DRAFT: ['PUBLISHED', 'CANCELLED'], PUBLISHED: ['CANCELLED'], CANCELLED: [] };

async function eventPage(where, params, paging, order) {
  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM events e JOIN venues v ON v.id = e.venue_id WHERE ${where}`,
    params,
  );
  const rows = await query(
    `${EVENT_SELECT} WHERE ${where} ORDER BY ${order}
     LIMIT ${paging.pageSize} OFFSET ${(paging.page - 1) * paging.pageSize}`,
    params,
  );
  return pageOf(rows.map(toEvent), total, paging);
}

router.get('/events', async (req, res) => {
  const q = parseQuery(req.query, {
    q: {},
    category: { enum: CATEGORIES },
    city: {},
    venueId: QUERY_ID_RULE,
    from: { type: 'date-time' },
    to: { type: 'date-time' },
    ...PAGE_RULES,
  });
  const conditions = ["e.status = 'PUBLISHED'", 'e.starts_at > ?'];
  const params = [new Date()];
  if (q.q) {
    conditions.push('(e.title LIKE ? OR e.description LIKE ?)');
    params.push(likeContains(q.q), likeContains(q.q));
  }
  if (q.category) {
    conditions.push('e.category = ?');
    params.push(q.category);
  }
  if (q.city) {
    conditions.push('v.city = ?');
    params.push(q.city);
  }
  if (q.venueId) {
    conditions.push('e.venue_id = ?');
    params.push(q.venueId);
  }
  if (q.from) {
    conditions.push('e.starts_at >= ?');
    params.push(q.from);
  }
  if (q.to) {
    conditions.push('e.starts_at <= ?');
    params.push(q.to);
  }
  res.json(await eventPage(conditions.join(' AND '), params, q, 'e.starts_at, e.id'));
});

router.post('/events', ...organizer, async (req, res) => {
  const body = validate(req.body, EVENT_RULES);
  let result;
  try {
    result = await query(
      `INSERT INTO events (organizer_id, venue_id, title, description, category, starts_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.auth.userId,
        body.venueId,
        body.title,
        body.description,
        body.category,
        toSeconds(body.startsAt),
      ],
    );
  } catch (err) {
    if (isMissingParent(err)) throw venueNotFound();
    throw err;
  }
  res.status(201).json(toEvent(await findEventRow(result.insertId)));
});

router.get('/organizer/events', ...organizer, async (req, res) => {
  const q = parseQuery(req.query, { status: { enum: STATUSES }, ...PAGE_RULES });
  const conditions = ['e.organizer_id = ?'];
  const params = [req.auth.userId];
  if (q.status) {
    conditions.push('e.status = ?');
    params.push(q.status);
  }
  res.json(await eventPage(conditions.join(' AND '), params, q, 'e.starts_at, e.id'));
});

router.get('/events/:eventId', optionalAuth, async (req, res) => {
  res.json(toEvent(await visibleEvent(req)));
});

router.put('/events/:eventId', ...organizer, async (req, res) => {
  const event = await ownedEvent(req);
  if (event.status === 'CANCELLED') throw invalidEventState(event.status);
  const body = validate(req.body, EVENT_RULES);
  let result;
  try {
    result = await query(
      `UPDATE events SET venue_id = ?, title = ?, description = ?, category = ?, starts_at = ?
       WHERE id = ? AND status <> 'CANCELLED'`,
      [
        body.venueId,
        body.title,
        body.description,
        body.category,
        toSeconds(body.startsAt),
        event.id,
      ],
    );
  } catch (err) {
    if (isMissingParent(err)) throw venueNotFound();
    throw err;
  }
  const updated = await findEventRow(event.id);
  if (!updated) throw eventNotFound();
  if (result.affectedRows === 0 && updated.status === 'CANCELLED') {
    throw invalidEventState(updated.status);
  }
  res.json(toEvent(updated));
});

router.delete('/events/:eventId', ...organizer, async (req, res) => {
  const event = await ownedEvent(req);
  if (event.status !== 'DRAFT') throw invalidEventState(event.status);
  const result = await query("DELETE FROM events WHERE id = ? AND status = 'DRAFT'", [event.id]);
  if (result.affectedRows === 0) {
    const current = await findEventRow(event.id);
    if (!current) throw eventNotFound();
    throw invalidEventState(current.status);
  }
  res.status(204).end();
});

const invalidTransition = (from, to) =>
  new HttpError(409, 'INVALID_EVENT_STATE', 'No se puede cambiar el evento a ese estado', {
    from,
    to,
  });

router.patch('/events/:eventId/status', ...organizer, async (req, res) => {
  const event = await ownedEvent(req);
  const { status: to } = validate(req.body, {
    status: { type: 'string', required: true, enum: ['PUBLISHED', 'CANCELLED'] },
  });
  const from = event.status;
  if (!TRANSITIONS[from].includes(to)) throw invalidTransition(from, to);
  if (to === 'PUBLISHED' && (await countZones(event.id)) === 0) {
    throw new HttpError(409, 'EVENT_HAS_NO_ZONES', 'Configure al menos una zona antes de publicar');
  }
  const result = await query('UPDATE events SET status = ? WHERE id = ? AND status = ?', [
    to,
    event.id,
    from,
  ]);
  const current = await findEventRow(event.id);
  if (!current) throw eventNotFound();
  if (result.affectedRows === 0) throw invalidTransition(current.status, to);
  res.json(toEvent(current));
});

router.get('/events/:eventId/poster', optionalAuth, async (req, _res) => {
  const event = await visibleEvent(req);
  if (!event.poster_key) {
    throw new HttpError(404, 'POSTER_NOT_FOUND', 'El evento no tiene póster');
  }
  throw serviceUnavailable();
});

router.put('/events/:eventId/poster', ...organizer, async (req, _res) => {
  await ownedEvent(req);
  throw serviceUnavailable();
});
