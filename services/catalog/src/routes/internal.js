import { Router } from 'express';
import { query } from '@tickethub/common/db';
import { HttpError, parseId, parseIdList, requireInternal } from '@tickethub/common/http';
import { EVENT_SELECT, eventNotFound, findEventRow, toEvent } from '../events.js';
import { findAssignment, toAssignment } from './staff.js';

export const router = Router();

router.get('/internal/events', requireInternal, async (req, res) => {
  const ids = parseIdList(req.query.ids, 'ids', 100);
  const rows = await query(`${EVENT_SELECT} WHERE e.id IN (${ids.map(() => '?').join(',')})`, ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  res.json(ids.filter((id) => byId.has(id)).map((id) => toEvent(byId.get(id))));
});

router.get('/internal/events/:eventId', requireInternal, async (req, res) => {
  const row = await findEventRow(parseId(req.params.eventId, eventNotFound));
  if (!row) throw eventNotFound();
  res.json(toEvent(row));
});

router.get('/internal/events/:eventId/staff/:userId', requireInternal, async (req, res) => {
  const notAssigned = () => new HttpError(404, 'NOT_ASSIGNED', 'No está asignado a este evento');
  const row = await findAssignment(
    parseId(req.params.eventId, notAssigned),
    parseId(req.params.userId, notAssigned),
  );
  if (!row) throw notAssigned();
  res.json(toAssignment(row));
});
