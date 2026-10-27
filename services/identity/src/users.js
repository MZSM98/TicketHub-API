import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { config } from './config.js';
import { query } from '@tickethub/common/db';
import { HttpError } from '@tickethub/common/http';

export const USER_COLUMNS =
  'id, name, email, role, status, organization_name, employer_id, must_change_password, created_at, updated_at, deleted_at';

const iso = (date) => (date ? date.toISOString().replace('.000Z', 'Z') : null);

/** Fila de `users` -> schema User de identity.yaml. `deletedAt` solo cuando se pide. */
export function toUser(row, { withDeletedAt = false } = {}) {
  const user = {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    organizationName: row.organization_name,
    employerId: row.employer_id,
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (withDeletedAt) user.deletedAt = iso(row.deleted_at);
  return user;
}

export async function findUserById(id, conn) {
  const rows = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id], conn);
  return rows[0] ?? null;
}

export const emailAlreadyRegistered = () =>
  new HttpError(409, 'EMAIL_ALREADY_REGISTERED', 'El correo ya está registrado');

export const hashPassword = (password) => bcrypt.hash(password, config.bcryptRounds);

/** Contraseña temporal para organizadores y personal: 12 caracteres aleatorios. */
export const generateTemporaryPassword = () => randomBytes(9).toString('base64url');

/** INSERT de un usuario; un correo repetido (incluso de una cuenta borrada) es 409. */
export async function insertUser(fields) {
  const { name, email, passwordHash, role, organizationName = null, employerId = null } = fields;
  const mustChangePassword = fields.mustChangePassword ?? false;
  try {
    const result = await query(
      `INSERT INTO users (name, email, password_hash, role, status, organization_name, employer_id, must_change_password)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [name, email, passwordHash, role, organizationName, employerId, mustChangePassword ? 1 : 0],
    );
    return findUserById(result.insertId);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw emailAlreadyRegistered();
    throw error;
  }
}
