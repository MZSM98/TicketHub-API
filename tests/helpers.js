// Utilidades compartidas por las pruebas de integración: llamadas HTTP, validación contra el
// contrato, sesiones y lectura de correos en Mailpit.
import assert from 'node:assert/strict';
import { assertContract } from './contract.js';

export const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080/api/v1';
export const IDENTITY = process.env.IDENTITY_URL ?? 'http://identity-service:3001/api/v1';
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://mailpit:8025';
export const { INTERNAL_TOKEN, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

export const RUN = Date.now().toString(36);
export const email = (who) => `${who}-${RUN}@example.com`;

export async function call(method, path, { body, token, headers = {}, base = GATEWAY } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

/** Llama por el gateway y valida status + cuerpo contra el contrato (template = ruta del contrato). */
export async function expectContract(method, path, status, options = {}, template = path) {
  const { res, body } = await call(method, path, options);
  assertContract(res, body, method, `/api/v1${template}`, status);
  return body;
}

export function jwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

export async function findEmail(to) {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages = [] } = await res.json();
    if (messages.length > 0) return messages[0];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No llegó correo a ${to}`);
}

/** Contraseña temporal del correo de credenciales (no se imprime). */
export async function temporaryPasswordFrom(message) {
  const res = await fetch(`${MAILPIT}/api/v1/message/${message.ID}`);
  const { Text } = await res.json();
  const match = /Contraseña temporal: (\S+)/.exec(Text);
  assert.ok(match, 'El correo no trae la contraseña temporal');
  return match[1];
}

export const login = (mail, password) =>
  expectContract('POST', '/auth/login', 200, { body: { email: mail, password } });

export const CATALOG = process.env.CATALOG_URL ?? 'http://catalog-service:3002/api/v1';

/** Cuenta creada por ADMIN (organizador) u ORGANIZER (personal), con sesión iniciada. */
async function accountWithSession(path, token, body) {
  const created = await expectContract('POST', path, 201, { token, body });
  const password = await temporaryPasswordFrom(await findEmail(body.email));
  const session = await login(body.email, password);
  return { id: created.user.id, token: session.accessToken };
}

export const createOrganizer = (adminToken, who) =>
  accountWithSession('/admin/organizers', adminToken, {
    name: `Organizador ${who}`,
    email: email(who),
    organizationName: `Producciones ${who}`,
  });

export const createStaff = (organizerToken, who) =>
  accountWithSession('/organizer/staff', organizerToken, {
    name: `Personal ${who}`,
    email: email(who),
  });
