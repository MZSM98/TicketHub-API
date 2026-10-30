import { Router } from 'express';
import { query } from '@tickethub/common/db';
import { requireInternal } from '@tickethub/common/http';

export const router = Router();

router.get('/internal/stats/sales', requireInternal, async (_req, res) => {
  const [row] = await query(
    "SELECT COUNT(*) AS purchases, COALESCE(SUM(total), 0) AS revenue FROM purchases WHERE status = 'PAID'",
  );
  const cents = Number(String(row.revenue).replace('.', ''));
  res.json({
    purchases: Number(row.purchases),
    grossRevenue: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`,
    currency: 'MXN',
  });
});

router.get(
  '/internal/reservations/:reservationId/payment-attempts',
  requireInternal,
  async (req, res) => {
    const rows = await query(
      `SELECT attempt, status, decline_code, last_error, recovery_attempts, updated_at
       FROM payment_attempts WHERE reservation_id = ? ORDER BY attempt`,
      [Number(req.params.reservationId) || 0],
    );
    res.json({
      items: rows.map((row) => ({
        attempt: row.attempt,
        status: row.status,
        declineCode: row.decline_code,
        lastError: row.last_error,
        recoveryAttempts: row.recovery_attempts,
        updatedAt: row.updated_at.toISOString().replace(/\.\d+Z$/, 'Z'),
      })),
    });
  },
);
