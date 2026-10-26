// /organizer/staff: el personal de evento que emplea el organizador autenticado.
import { Router } from 'express';
import {
  authenticate,
  PAGE_RULES,
  parseQuery,
  requireRole,
  validate,
} from '@tickethub/common/http';
import { createWithEmailedCredentials, userPage } from './admin.js';

export const router = Router();
router.use('/organizer/staff', authenticate, requireRole('ORGANIZER'));

router.get('/organizer/staff', async (req, res) => {
  const q = parseQuery(req.query, { status: { enum: ['ACTIVE', 'SUSPENDED'] }, ...PAGE_RULES });
  const conditions = ["role = 'STAFF'", 'employer_id = ?', 'deleted_at IS NULL'];
  const params = [req.auth.userId];
  if (q.status) {
    conditions.push('status = ?');
    params.push(q.status);
  }
  res.json(await userPage(conditions.join(' AND '), params, q));
});

router.post('/organizer/staff', async (req, res) => {
  const body = validate(req.body, {
    name: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 120 },
    email: { type: 'string', required: true, trim: true, maxLength: 255, format: 'email' },
  });
  const result = await createWithEmailedCredentials({
    name: body.name,
    email: body.email.toLowerCase(),
    role: 'STAFF',
    employerId: req.auth.userId,
  });
  res.status(201).json(result);
});
