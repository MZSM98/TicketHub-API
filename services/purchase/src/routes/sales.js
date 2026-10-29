import { Router } from 'express';
import { query } from '@tickethub/common/db';
import { authenticate, HttpError, parseId, requireRole } from '@tickethub/common/http';
import { getEvent, zonesOfEvent } from '../services.js';

export const router = Router();

const eventNotFound = () => new HttpError(404, 'EVENT_NOT_FOUND', 'El evento no existe');
const notEventOwner = (eventId) =>
  new HttpError(403, 'NOT_EVENT_OWNER', 'Solo el organizador dueño del evento puede verlo', {
    eventId,
  });

const toCents = (money) => Number(String(money ?? '0.00').replace('.', ''));
const fromCents = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

router.get('/events/:eventId/sales', authenticate, requireRole('ORGANIZER'), async (req, res) => {
  const eventId = parseId(req.params.eventId, eventNotFound);
  const event = await getEvent(eventId);
  if (!event) throw eventNotFound();
  if (event.organizerId !== req.auth.userId) throw notEventOwner(eventId);
  const zones = await zonesOfEvent(eventId);
  const [totals] = await query(
    "SELECT COUNT(*) AS purchases, COALESCE(SUM(total), 0) AS revenue FROM purchases WHERE event_id = ? AND status = 'PAID'",
    [eventId],
  );
  const days = await query(
    `SELECT DATE_FORMAT(CONVERT_TZ(updated_at, '+00:00', '-06:00'), '%Y-%m-%d') AS day,
              COUNT(*) AS purchases, SUM(total) AS revenue
         FROM purchases WHERE event_id = ? AND status = 'PAID'
        GROUP BY day ORDER BY day`,
    [eventId],
  );
  const zoneRevenue = await query(
    `SELECT pi.zone_id AS zoneId, SUM(pi.unit_price * pi.quantity) AS revenue
       FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
      WHERE p.event_id = ? AND p.status = 'PAID'
      GROUP BY pi.zone_id`,
    [eventId],
  );
  const revenueOf = new Map(zoneRevenue.map((row) => [row.zoneId, toCents(row.revenue)]));
  const ticketsSold = zones.reduce((sum, zone) => sum + zone.soldCount, 0);
  const capacity = zones.reduce((sum, zone) => sum + zone.capacity, 0);
  res.json({
    eventId,
    currency: 'MXN',
    purchases: Number(totals.purchases),
    ticketsSold,
    grossRevenue: fromCents(toCents(totals.revenue)),
    capacity,
    occupancyRate: capacity === 0 ? 0 : Number((ticketsSold / capacity).toFixed(4)),
    byZone: zones.map((zone) => ({
      zoneId: zone.id,
      name: zone.name,
      price: zone.price,
      capacity: zone.capacity,
      sold: zone.soldCount,
      reserved: zone.reservedCount,
      revenue: fromCents(revenueOf.get(zone.id) ?? 0),
    })),
    byDay: days.map((day) => ({
      date: day.day,
      purchases: Number(day.purchases),
      revenue: fromCents(toCents(day.revenue)),
    })),
  });
});
