import { Router } from 'express';
import { query } from '@tickethub/common/db';
import { HttpError, parseId, parseIdList, requireInternal, validate } from '@tickethub/common/http';
import {
  confirmAction,
  releaseAction,
  reservationNotFound,
  revokeSaleAction,
  withReservation,
} from '../reservations.js';
import { toZone, ZONE_COLUMNS } from '../zones.js';

export const router = Router();

const reservationId = (req) => parseId(req.params.reservationId, reservationNotFound);

router.get('/internal/reservations/:reservationId', requireInternal, async (req, res) => {
  const id = reservationId(req);
  const reservation = await withReservation(id);
  const [row] = await query('SELECT purchase_id FROM reservations WHERE id = ?', [id]);
  res.json({ ...reservation, purchaseId: row?.purchase_id ?? null });
});

router.post(
  '/internal/reservations/:reservationId/confirm-sale',
  requireInternal,
  async (req, res) => {
    const id = reservationId(req);
    const { purchaseId } = validate(req.body, { purchaseId: { type: 'id', required: true } });
    res.json(await withReservation(id, confirmAction(purchaseId)));
  },
);

router.post('/internal/reservations/:reservationId/release', requireInternal, async (req, res) => {
  res.json(await withReservation(reservationId(req), releaseAction));
});

router.post(
  '/internal/reservations/:reservationId/revoke-sale',
  requireInternal,
  async (req, res) => {
    const id = reservationId(req);
    const { purchaseId } = validate(req.body, { purchaseId: { type: 'id', required: true } });
    res.json(await withReservation(id, revokeSaleAction(purchaseId)));
  },
);

const onlyOneFilter = () =>
  new HttpError(
    400,
    'VALIDATION_ERROR',
    'Algunos datos no son válidos, revise los campos marcados',
    {
      fields: [
        { field: 'ids', issue: 'invalid_value' },
        { field: 'eventId', issue: 'invalid_value' },
      ],
    },
  );

router.get('/internal/zones', requireInternal, async (req, res) => {
  const { ids: rawIds, eventId: rawEventId } = req.query;
  const hasIds = rawIds !== undefined;
  const hasEvent = rawEventId !== undefined;
  if (hasIds === hasEvent) throw onlyOneFilter();
  if (hasEvent) {
    if (
      typeof rawEventId !== 'string' ||
      !/^\d{1,15}$/.test(rawEventId) ||
      Number(rawEventId) < 1
    ) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'Algunos datos no son válidos, revise los campos marcados',
        {
          fields: [{ field: 'eventId', issue: 'invalid_value' }],
        },
      );
    }
    const rows = await query(`SELECT ${ZONE_COLUMNS} FROM zones WHERE event_id = ? ORDER BY id`, [
      Number(rawEventId),
    ]);
    return res.json(rows.map(toZone));
  }
  const ids = parseIdList(rawIds, 'ids', 100);
  const rows = await query(
    `SELECT ${ZONE_COLUMNS} FROM zones WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  res.json(ids.filter((id) => byId.has(id)).map((id) => toZone(byId.get(id))));
});

router.delete('/internal/events/:eventId/zones', requireInternal, async (req, res) => {
  if (/^\d{1,15}$/.test(req.params.eventId)) {
    await query('DELETE FROM zones WHERE event_id = ?', [Number(req.params.eventId)]);
  }
  res.status(204).end();
});
