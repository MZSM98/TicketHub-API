// /users/me/**: la cuenta del usuario autenticado.
import bcrypt from 'bcrypt';
import { Router } from 'express';
import { query, transaction } from '@tickethub/common/db';
import { authenticate, HttpError, unauthorized, validate } from '@tickethub/common/http';
import { NEW_PASSWORD_RULE } from '../passwords.js';
import { hashToken, revokeAllRefreshTokens } from '../tokens.js';
import { findUserById, hashPassword, toUser } from '../users.js';

export const router = Router();

/** El usuario del token; una cuenta borrada ya no tiene sesión válida. */
async function currentUser(req) {
  const user = await findUserById(req.auth.userId);
  if (!user || user.deleted_at) throw unauthorized();
  return user;
}

router.get('/users/me', authenticate, async (req, res) => {
  res.json(toUser(await currentUser(req)));
});

router.put('/users/me/password', authenticate, async (req, res) => {
  const body = validate(req.body, {
    currentPassword: { type: 'string', required: true },
    newPassword: NEW_PASSWORD_RULE,
    refreshToken: { type: 'string', minLength: 1, maxLength: 512 },
  });
  const user = await currentUser(req);
  const [{ password_hash: currentHash }] = await query(
    'SELECT password_hash FROM users WHERE id = ?',
    [user.id],
  );
  if (!(await bcrypt.compare(body.currentPassword, currentHash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'La contraseña actual no es correcta');
  }
  const newHash = await hashPassword(body.newPassword);
  await transaction(async (conn) => {
    await query(
      'UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE id = ?',
      [newHash, user.id],
      conn,
    );
    // Se cierran las demás sesiones; la del refreshToken enviado (si es suyo) sigue vigente.
    const keep = body.refreshToken ? hashToken(body.refreshToken) : null;
    await revokeAllRefreshTokens(user.id, conn, keep);
  });
  res.status(204).end();
});
