// /internal/**: solo entre servicios (X-Internal-Token). El gateway no las enruta.
// requireInternal va en cada ruta, no en el prefijo, para que una ruta /internal desconocida
// responda 404 y no 401.
import { Router } from 'express';
import { query } from '../db.js';
import { HttpError, parseId, parseIdList, requireInternal } from '../http.js';
import { EVENT_SELECT, eventNotFound, findEventRow, toEvent } from '../events.js';
import { findAssignment, toAssignment } from './staff.js';

export const router = Router();

router.get('/internal/events', requireInternal, async (req, res) => {
  const ids = parseIdList(req.query.ids, 'ids', 100);
  const rows = await query(`${EVENT_SELECT} WHERE e.id IN (${ids.map(() => '?').join(',')})`, ids);
  // Mismo orden que los ids pedidos; los que no existen se omiten.
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
