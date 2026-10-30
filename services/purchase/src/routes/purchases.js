import { Router } from 'express';
import { query } from '@tickethub/common/db';
import {
  authenticate,
  forbidden,
  PAGE_RULES,
  pageOf,
  parseId,
  parseQuery,
  requireRole,
  validate,
} from '@tickethub/common/http';
import { processPurchase, PURCHASE_COLUMNS, purchaseNotFound, toPurchase } from '../purchases.js';

export const router = Router();
const buyer = [authenticate, requireRole('BUYER')];

router.post('/purchases', ...buyer, async (req, res) => {
  const body = validate(req.body, {
    reservationId: { type: 'id', required: true },
    paymentMethodToken: { type: 'string', required: true, minLength: 1, maxLength: 255 },
  });
  res.status(201).json(await processPurchase(req.auth.userId, body));
});

router.get('/purchases/me', ...buyer, async (req, res) => {
  const paging = parseQuery(req.query, PAGE_RULES);
  const [{ total }] = await query(
    "SELECT COUNT(*) AS total FROM purchases WHERE user_id = ? AND status = 'PAID'",
    [req.auth.userId],
  );
  const rows = await query(
    `SELECT ${PURCHASE_COLUMNS} FROM purchases WHERE user_id = ? AND status = 'PAID'
     ORDER BY created_at DESC, id DESC
     LIMIT ${paging.pageSize} OFFSET ${(paging.page - 1) * paging.pageSize}`,
    [req.auth.userId],
  );
  res.json(pageOf(rows.map(toPurchase), total, paging));
});

router.get('/purchases/:purchaseId', ...buyer, async (req, res) => {
  const id = parseId(req.params.purchaseId, purchaseNotFound);
  const [row] = await query(`SELECT ${PURCHASE_COLUMNS} FROM purchases WHERE id = ?`, [id]);
  if (!row) throw purchaseNotFound();
  if (row.user_id !== req.auth.userId) throw forbidden();
  res.json(toPurchase(row));
});
