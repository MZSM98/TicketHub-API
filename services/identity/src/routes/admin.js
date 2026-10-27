// /admin/**: administración de cuentas (CU-14) y alta de organizadores (CU-15). Rol ADMIN.
import { Router } from 'express';
import { query, transaction } from '@tickethub/common/db';
import {
  authenticate,
  HttpError,
  notFound,
  PAGE_RULES,
  parseId,
  parseQuery,
  requireRole,
  validate,
} from '@tickethub/common/http';
import { sendCredentialsEmail } from '../mail.js';
import { revokeAllRefreshTokens } from '../tokens.js';
import {
  findUserById,
  generateTemporaryPassword,
  hashPassword,
  insertUser,
  toUser,
  USER_COLUMNS,
} from '../users.js';

export const router = Router();
router.use('/admin', authenticate, requireRole('ADMIN'));

const ROLES = ['BUYER', 'STAFF', 'ORGANIZER', 'ADMIN'];
const STATUSES = ['ACTIVE', 'SUSPENDED'];

/** Página de usuarios con el formato UserPage (PageMeta + items). */
export async function userPage(where, params, { page, pageSize }, rowOptions) {
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM users WHERE ${where}`, params);
  // page y pageSize ya son enteros validados.
  const rows = await query(
    `SELECT ${USER_COLUMNS} FROM users WHERE ${where}
     ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );
  return {
    items: rows.map((row) => toUser(row, rowOptions)),
    page,
    pageSize,
    totalItems: total,
    totalPages: Math.ceil(total / pageSize),
  };
}

router.get('/admin/users', async (req, res) => {
  const q = parseQuery(req.query, {
    role: { enum: ROLES },
    status: { enum: STATUSES },
    q: {},
    includeDeleted: { type: 'boolean', default: false },
    ...PAGE_RULES,
  });
  const conditions = [];
  const params = [];
  if (!q.includeDeleted) conditions.push('deleted_at IS NULL');
  if (q.role) {
    conditions.push('role = ?');
    params.push(q.role);
  }
  if (q.status) {
    conditions.push('status = ?');
    params.push(q.status);
  }
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push('(name LIKE ? OR email LIKE ? OR organization_name LIKE ?)');
    params.push(like, like, like);
  }
  const where = conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';
  res.json(await userPage(where, params, q, { withDeletedAt: q.includeDeleted }));
});

function rejectSelf(req, userId, message) {
  if (userId === req.auth.userId) throw new HttpError(409, 'CANNOT_MODIFY_SELF', message);
}

router.delete('/admin/users/:userId', async (req, res) => {
  const userId = parseId(req.params.userId);
  rejectSelf(req, userId, 'No puede eliminar su propia cuenta');
  await transaction(async (conn) => {
    const result = await query(
      'UPDATE users SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
      [userId],
      conn,
    );
    if (result.affectedRows === 0) throw notFound();
    await revokeAllRefreshTokens(userId, conn);
  });
  res.status(204).end();
});

router.patch('/admin/users/:userId/status', async (req, res) => {
  const userId = parseId(req.params.userId);
  const { status } = validate(req.body, {
    status: { type: 'string', required: true, enum: STATUSES },
  });
  rejectSelf(req, userId, 'No puede cambiar el estado de su propia cuenta');
  const user = await transaction(async (conn) => {
    const current = await findUserById(userId, conn);
    if (!current || current.deleted_at) throw notFound();
    await query('UPDATE users SET status = ? WHERE id = ?', [status, userId], conn);
    if (status === 'SUSPENDED') await revokeAllRefreshTokens(userId, conn);
    return findUserById(userId, conn);
  });
  res.json(toUser(user));
});

/** Alta con contraseña temporal y correo de credenciales (CU-15 y personal de organizador). */
export async function createWithEmailedCredentials(fields) {
  const temporaryPassword = generateTemporaryPassword();
  const user = await insertUser({
    ...fields,
    passwordHash: await hashPassword(temporaryPassword),
    mustChangePassword: true,
  });
  const credentialsEmailSent = await sendCredentialsEmail({
    to: user.email,
    name: user.name,
    role: user.role,
    temporaryPassword,
  });
  return { user: toUser(user), credentialsEmailSent };
}

router.post('/admin/organizers', async (req, res) => {
  const body = validate(req.body, {
    name: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 120 },
    email: { type: 'string', required: true, trim: true, maxLength: 255, format: 'email' },
    organizationName: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 160 },
  });
  const result = await createWithEmailedCredentials({
    name: body.name,
    email: body.email.toLowerCase(),
    organizationName: body.organizationName,
    role: 'ORGANIZER',
  });
  res.status(201).json(result);
});
