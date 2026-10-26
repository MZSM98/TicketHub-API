import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, HttpError, notFound, parseId, requireRole } from '../http.js';
import { EVENT_SELECT, eventNotFound, isMissingParent, ownedEvent, toEvent } from '../events.js';
import { getUser } from '../services.js';

export const router = Router();
const organizer = [authenticate, requireRole('ORGANIZER')];

const iso = (date) => date.toISOString().replace('.000Z', 'Z');

export const toAssignment = (row) => ({
  eventId: row.event_id,
  userId: row.user_id,
  assignedAt: iso(row.assigned_at),
});

export async function findAssignment(eventId, userId) {
  const [row] = await query(
    'SELECT event_id, user_id, assigned_at FROM event_staff WHERE event_id = ? AND user_id = ?',
    [eventId, userId],
  );
  return row ?? null;
}

router.get('/events/:eventId/staff', ...organizer, async (req, res) => {
  const event = await ownedEvent(req);
  const rows = await query(
    `SELECT event_id, user_id, assigned_at FROM event_staff WHERE event_id = ?
     ORDER BY assigned_at, user_id`,
    [event.id],
  );
  res.json(rows.map(toAssignment));
});

router.put('/events/:eventId/staff/:userId', ...organizer, async (req, res) => {
  const event = await ownedEvent(req);
  const notOwnStaff = () =>
    new HttpError(403, 'NOT_OWN_STAFF', 'El usuario no pertenece a su personal');
  const userId = parseId(req.params.userId, notOwnStaff);
  const user = await getUser(userId);
  if (
    !user ||
    user.role !== 'STAFF' ||
    user.status !== 'ACTIVE' ||
    user.deletedAt ||
    user.employerId !== req.auth.userId
  ) {
    throw notOwnStaff();
  }
  try {
    await query('INSERT IGNORE INTO event_staff (event_id, user_id) VALUES (?, ?)', [
      event.id,
      userId,
    ]);
  } catch (err) {
    if (isMissingParent(err)) throw eventNotFound();
    throw err;
  }
  const row = await findAssignment(event.id, userId);
  if (!row) throw eventNotFound();
  res.json(toAssignment(row));
});

router.delete('/events/:eventId/staff/:userId', ...organizer, async (req, res) => {
  const event = await ownedEvent(req);
  const userId = parseId(req.params.userId);
  const result = await query('DELETE FROM event_staff WHERE event_id = ? AND user_id = ?', [
    event.id,
    userId,
  ]);
  if (result.affectedRows === 0) throw notFound();
  res.status(204).end();
});

router.get('/staff/events', authenticate, requireRole('STAFF'), async (req, res) => {
  const rows = await query(
    `${EVENT_SELECT} JOIN event_staff s ON s.event_id = e.id
     WHERE s.user_id = ? AND e.status <> 'CANCELLED' ORDER BY e.starts_at, e.id`,
    [req.auth.userId],
  );
  res.json(rows.map(toEvent));
});
