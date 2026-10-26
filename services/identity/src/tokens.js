// Access token (JWT HS256) y refresh token opaco, del que solo se guarda el SHA-256.
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { query } from './db.js';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function signAccessToken(user) {
  // Claims de common.yaml: sub, role, employerId (solo STAFF), exp.
  const payload = { sub: String(user.id), role: user.role };
  if (user.role === 'STAFF') payload.employerId = user.employer_id;
  return jwt.sign(payload, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtExpiresIn,
  });
}

/** Crea un refresh token nuevo y regresa el TokenPair del contrato. */
export async function issueTokenPair(user, conn) {
  const refreshToken = randomBytes(32).toString('base64url');
  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, NOW() + INTERVAL ? DAY)',
    [user.id, hashToken(refreshToken), config.refreshTokenTtlDays],
    conn,
  );
  return {
    accessToken: signAccessToken(user),
    tokenType: 'Bearer',
    expiresIn: config.jwtExpiresIn,
    refreshToken,
    refreshExpiresIn: config.refreshTokenTtlDays * 86400,
  };
}

/** Revoca todos los refresh tokens vigentes del usuario, salvo el de `keepHash` si se indica. */
export async function revokeAllRefreshTokens(userId, conn, keepHash = null) {
  await query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
     WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR token_hash <> ?)`,
    [userId, keepHash, keepHash],
    conn,
  );
}
