import { Router } from 'express';
import { query } from '@tickethub/common/db';
import { notFound, parseId, requireInternal } from '@tickethub/common/http';
import { findUserById, toUser } from '../users.js';

export const router = Router();
router.get('/internal/users/:userId', requireInternal, async (req, res) => {
  const user = await findUserById(parseId(req.params.userId));
  if (!user) throw notFound();
  res.json(toUser(user, { withDeletedAt: true }));
});

router.get('/internal/stats/users', requireInternal, async (_req, res) => {
  const rows = await query(
    `SELECT role, COUNT(*) AS total, SUM(status = 'SUSPENDED') AS suspended
     FROM users WHERE deleted_at IS NULL GROUP BY role`,
  );
  const byRole = { BUYER: 0, STAFF: 0, ORGANIZER: 0, ADMIN: 0 };
  let suspended = 0;
  for (const row of rows) {
    byRole[row.role] = Number(row.total);
    suspended += Number(row.suspended);
  }
  const total = Object.values(byRole).reduce((sum, n) => sum + n, 0);
  res.json({ total, byRole, suspended });
});
