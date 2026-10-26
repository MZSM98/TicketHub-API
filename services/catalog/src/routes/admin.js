import { Router } from 'express';
import { query } from '@tickethub/common/db';
import { authenticate, requireRole } from '@tickethub/common/http';
import { salesStats, userStats } from '../services.js';

export const router = Router();

router.get('/admin/summary', authenticate, requireRole('ADMIN'), async (_req, res) => {
  const now = new Date();
  const [statusRows, [{ upcoming }], [{ venues }], users, sales] = await Promise.all([
    query('SELECT status, COUNT(*) AS total FROM events GROUP BY status'),
    query("SELECT COUNT(*) AS upcoming FROM events WHERE status = 'PUBLISHED' AND starts_at > ?", [
      now,
    ]),
    query('SELECT COUNT(*) AS venues FROM venues'),
    userStats(),
    salesStats(),
  ]);
  const byStatus = { DRAFT: 0, PUBLISHED: 0, CANCELLED: 0 };
  for (const row of statusRows) byStatus[row.status] = Number(row.total);
  const unavailableSections = [];
  if (!users) unavailableSections.push('users');
  if (!sales) unavailableSections.push('sales');
  res.json({
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    events: {
      total: byStatus.DRAFT + byStatus.PUBLISHED + byStatus.CANCELLED,
      byStatus,
      upcoming: Number(upcoming),
    },
    venues: { total: Number(venues) },
    users,
    sales,
    unavailableSections,
  });
});
