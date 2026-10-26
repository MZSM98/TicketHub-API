// /internal/**: solo entre servicios (X-Internal-Token). El gateway no las enruta.
import { Router } from 'express';
import { query } from '../db.js';
import { notFound, parseId, requireInternal } from '../http.js';
import { findUserById, toUser } from '../users.js';

export const router = Router();
router.use('/internal', requireInternal);

router.get('/internal/users/:userId', async (req, res) => {
  const user = await findUserById(parseId(req.params.userId));
  if (!user) throw notFound();
  // También regresa cuentas borradas, con deletedAt.
  res.json(toUser(user, { withDeletedAt: true }));
});

router.get('/internal/stats/users', async (_req, res) => {
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
