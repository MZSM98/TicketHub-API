// /auth/**: registro (CU-01), login (CU-02), refresh con rotación y logout. Rutas públicas.
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Router } from 'express';
import { config } from '../config.js';
import { query, transaction } from '../db.js';
import { HttpError, NEW_PASSWORD_RULE, validate } from '../http.js';
import { hashToken, issueTokenPair } from '../tokens.js';
import { hashPassword, insertUser, toUser, USER_COLUMNS } from '../users.js';

export const router = Router();

const NAME = { type: 'string', required: true, trim: true, minLength: 1, maxLength: 120 };
const EMAIL = { type: 'string', required: true, trim: true, maxLength: 255, format: 'email' };
const REFRESH_TOKEN = { type: 'string', required: true, minLength: 1, maxLength: 512 };

const invalidCredentials = () =>
  new HttpError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
export const accountSuspended = () =>
  new HttpError(403, 'ACCOUNT_SUSPENDED', 'Su cuenta está suspendida, contacte al administrador');
const invalidRefreshToken = () =>
  new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Sesión expirada, inicie sesión de nuevo');

// Hash de una contraseña aleatoria: el login tarda lo mismo exista o no el correo.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), config.bcryptRounds);

router.post('/auth/register', async (req, res) => {
  const body = validate(req.body, { name: NAME, email: EMAIL, password: NEW_PASSWORD_RULE });
  const user = await insertUser({
    name: body.name,
    email: body.email.toLowerCase(),
    passwordHash: await hashPassword(body.password),
    role: 'BUYER',
  });
  res.status(201).json(toUser(user));
});

router.post('/auth/login', async (req, res) => {
  const body = validate(req.body, {
    email: EMAIL,
    password: { type: 'string', required: true },
  });
  const [row] = await query(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = ?`, [
    body.email,
  ]);
  const passwordOk = await bcrypt.compare(body.password, row?.password_hash ?? DUMMY_HASH);
  if (!row || row.deleted_at || !passwordOk) throw invalidCredentials();
  if (row.status === 'SUSPENDED') throw accountSuspended();
  const pair = await issueTokenPair(row);
  res.json({ ...pair, user: toUser(row) });
});

router.post('/auth/refresh', async (req, res) => {
  const { refreshToken } = validate(req.body, { refreshToken: REFRESH_TOKEN });
  const pair = await transaction(async (conn) => {
    const [row] = await query(
      `SELECT rt.id AS token_id, rt.revoked_at, rt.expires_at > NOW() AS live,
              u.id, u.role, u.status, u.employer_id, u.deleted_at
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = ? FOR UPDATE`,
      [hashToken(refreshToken)],
      conn,
    );
    if (!row || row.deleted_at) throw invalidRefreshToken();
    if (row.status === 'SUSPENDED') throw accountSuspended();
    if (row.revoked_at || !row.live) throw invalidRefreshToken();
    // Rotación: el token enviado queda revocado y se emite un par nuevo.
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [row.token_id], conn);
    return issueTokenPair(row, conn);
  });
  res.json(pair);
});

router.post('/auth/logout', async (req, res) => {
  const { refreshToken } = validate(req.body, { refreshToken: REFRESH_TOKEN });
  // Idempotente: un token desconocido, vencido o ya revocado también responde 204.
  await query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL',
    [hashToken(refreshToken)],
  );
  res.status(204).end();
});
