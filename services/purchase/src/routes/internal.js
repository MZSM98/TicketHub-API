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
