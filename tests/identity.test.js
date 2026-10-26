// Pruebas de integración de IdentityService a través del API Gateway (identity.yaml, gateway.yaml).
// Requieren el stack levantado; se ejecutan con `npm test` (ver README).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { authMode } from '../services/gateway/src/routes.js';
import { assertContract, assertSchema, contractSecurity, responseSchema } from './contract.js';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080/api/v1';
const IDENTITY = process.env.IDENTITY_URL ?? 'http://identity-service:3001/api/v1';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://mailpit:8025';
const { INTERNAL_TOKEN, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

const RUN = Date.now().toString(36);
const email = (who) => `${who}-${RUN}@example.com`;

async function call(method, path, { body, token, headers = {}, base = GATEWAY } = {}) {
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
async function expectContract(method, path, status, options = {}, template = path) {
  const { res, body } = await call(method, path, options);
  assertContract(res, body, method, `/api/v1${template}`, status);
  return body;
}

function jwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

async function findEmail(to) {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages = [] } = await res.json();
    if (messages.length > 0) return messages[0];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No llegó correo a ${to}`);
}

/** Contraseña temporal del correo de credenciales (no se imprime). */
async function temporaryPasswordFrom(message) {
  const res = await fetch(`${MAILPIT}/api/v1/message/${message.ID}`);
  const { Text } = await res.json();
  const match = /Contraseña temporal: (\S+)/.exec(Text);
  assert.ok(match, 'El correo no trae la contraseña temporal');
  return match[1];
}

const login = (mail, password) =>
  expectContract('POST', '/auth/login', 200, { body: { email: mail, password } });

describe('Gateway: seguridad por ruta', () => {
  test('la tabla de rutas públicas del gateway coincide con security de los contratos', () => {
    for (const { method, path, mode } of contractSecurity()) {
      const concrete = path.replace('/api/v1', '').replace(/\{[^}]+\}/g, '1');
      assert.equal(authMode(method, concrete), mode, `${method} ${path}`);
    }
  });

  test('ruta protegida sin token o con token inválido -> 401 del gateway', async () => {
    await expectContract('GET', '/users/me', 401);
    await expectContract('GET', '/users/me', 401, { token: 'no-es-un-jwt' });
  });

  test('/internal/** no se enruta por el gateway -> 404', async () => {
    const { res, body } = await call('GET', '/internal/users/1', {
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    });
    assert.equal(res.status, 404);
    assert.equal(body.code, 'NOT_FOUND');
  });
});

describe('IdentityService (identity.yaml)', () => {
  const buyer = { name: 'Ana López', email: email('buyer'), password: 'S3gura!2026' };
  const state = {};

  test('POST /auth/register -> 201 User; correo repetido -> 409; inválido -> 400', async () => {
    const user = await expectContract('POST', '/auth/register', 201, { body: buyer });
    assert.equal(user.role, 'BUYER');
    assert.equal(user.status, 'ACTIVE');
    assert.equal(user.mustChangePassword, false);
    assert.equal('deletedAt' in user, false);
    state.buyerId = user.id;

    const dup = await expectContract('POST', '/auth/register', 409, {
      body: { ...buyer, email: buyer.email.toUpperCase() },
    });
    assert.equal(dup.code, 'EMAIL_ALREADY_REGISTERED');

    const invalid = await expectContract('POST', '/auth/register', 400, {
      body: { name: '', email: 'no-es-correo', password: 'corta' },
    });
    assert.equal(invalid.code, 'VALIDATION_ERROR');
    assert.deepEqual(invalid.details.fields.map((f) => f.field).sort(), [
      'email',
      'name',
      'password',
    ]);
  });

  test('POST /auth/login -> 200 con tokens; contraseña mala o correo desconocido -> 401', async () => {
    const session = await login(buyer.email, buyer.password);
    assert.equal(session.tokenType, 'Bearer');
    assert.equal(session.expiresIn, 3600);
    assert.equal(session.refreshExpiresIn, 604800);
    const claims = jwtPayload(session.accessToken);
    assert.equal(claims.sub, String(state.buyerId));
    assert.equal(claims.role, 'BUYER');
    assert.equal('employerId' in claims, false);
    assert.equal(claims.exp - claims.iat, 3600);
    state.buyerSession = session;

    for (const body of [
      { email: buyer.email, password: 'incorrecta' },
      { email: email('nadie'), password: 'loquesea123' },
    ]) {
      const err = await expectContract('POST', '/auth/login', 401, { body });
      assert.equal(err.code, 'INVALID_CREDENTIALS');
    }
  });

  test('GET /users/me con token -> 200 User', async () => {
    const me = await expectContract('GET', '/users/me', 200, {
      token: state.buyerSession.accessToken,
    });
    assert.equal(me.id, state.buyerId);
    assert.equal(me.email, buyer.email);
  });

  test('POST /auth/refresh rota el par; el refresh anterior queda rechazado', async () => {
    const old = state.buyerSession.refreshToken;
    const pair = await expectContract('POST', '/auth/refresh', 200, {
      body: { refreshToken: old },
    });
    assert.notEqual(pair.refreshToken, old);
    const again = await expectContract('POST', '/auth/refresh', 401, {
      body: { refreshToken: old },
    });
    assert.equal(again.code, 'INVALID_REFRESH_TOKEN');
    state.buyerSession = { ...state.buyerSession, ...pair };
    await expectContract('GET', '/users/me', 200, { token: pair.accessToken });
  });

  test('POST /auth/logout -> 204 (idempotente) y el refresh ya no sirve', async () => {
    const session = await login(buyer.email, buyer.password);
    const body = { refreshToken: session.refreshToken };
    await expectContract('POST', '/auth/logout', 204, { body });
    await expectContract('POST', '/auth/logout', 204, { body });
    await expectContract('POST', '/auth/logout', 204, { body: { refreshToken: 'desconocido' } });
    const err = await expectContract('POST', '/auth/refresh', 401, { body });
    assert.equal(err.code, 'INVALID_REFRESH_TOKEN');
    await expectContract('POST', '/auth/logout', 400, { body: {} });
  });

  test('PUT /users/me/password: actual incorrecta -> 401; cambio cierra las otras sesiones', async () => {
    const deviceA = await login(buyer.email, buyer.password);
    const deviceB = await login(buyer.email, buyer.password);
    const wrong = await expectContract('PUT', '/users/me/password', 401, {
      token: deviceA.accessToken,
      body: { currentPassword: 'incorrecta', newPassword: 'MiNueva!2026' },
    });
    assert.equal(wrong.code, 'INVALID_CREDENTIALS');

    await expectContract('PUT', '/users/me/password', 204, {
      token: deviceA.accessToken,
      body: {
        currentPassword: buyer.password,
        newPassword: 'MiNueva!2026',
        refreshToken: deviceA.refreshToken,
      },
    });
    buyer.password = 'MiNueva!2026';
    // El dispositivo que cambió la contraseña sigue; el otro debe iniciar sesión de nuevo.
    state.buyerSession = await expectContract('POST', '/auth/refresh', 200, {
      body: { refreshToken: deviceA.refreshToken },
    });
    await expectContract('POST', '/auth/refresh', 401, {
      body: { refreshToken: deviceB.refreshToken },
    });
    await expectContract('POST', '/auth/login', 401, {
      body: { email: buyer.email, password: 'S3gura!2026' },
    });
    await login(buyer.email, buyer.password);
  });

  test('admin: comprador en ruta de admin -> 403; admin lista usuarios con filtros', async () => {
    const forbidden = await expectContract('GET', '/admin/users', 403, {
      token: state.buyerSession.accessToken,
    });
    assert.equal(forbidden.code, 'FORBIDDEN');

    state.admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const page = await expectContract(
      'GET',
      `/admin/users?q=${encodeURIComponent(buyer.email)}`,
      200,
      { token: state.admin.accessToken },
      '/admin/users',
    );
    assert.equal(page.totalItems, 1);
    assert.equal(page.items[0].id, state.buyerId);
    assert.equal('deletedAt' in page.items[0], false);

    const admins = await expectContract(
      'GET',
      '/admin/users?role=ADMIN&pageSize=5',
      200,
      { token: state.admin.accessToken },
      '/admin/users',
    );
    assert.ok(admins.items.every((u) => u.role === 'ADMIN'));
    assert.equal(admins.pageSize, 5);

    const bad = await call('GET', '/admin/users?pageSize=500&role=X', {
      token: state.admin.accessToken,
    });
    assert.equal(bad.res.status, 400);
    assertSchema(responseSchema('POST', '/api/v1/auth/register', 400), bad.body, '400');
  });

  test('admin: suspender -> login 403 y refresh 403; reactivar -> login 200', async () => {
    const path = `/admin/users/${state.buyerId}/status`;
    const template = '/admin/users/{userId}/status';
    const token = state.admin.accessToken;
    const suspended = await expectContract(
      'PATCH',
      path,
      200,
      { token, body: { status: 'SUSPENDED' } },
      template,
    );
    assert.equal(suspended.status, 'SUSPENDED');

    const err = await expectContract('POST', '/auth/login', 403, {
      body: { email: buyer.email, password: buyer.password },
    });
    assert.equal(err.code, 'ACCOUNT_SUSPENDED');
    const refresh = await expectContract('POST', '/auth/refresh', 403, {
      body: { refreshToken: state.buyerSession.refreshToken },
    });
    assert.equal(refresh.code, 'ACCOUNT_SUSPENDED');

    await expectContract('PATCH', path, 400, { token, body: { status: 'BORRADO' } }, template);
    const active = await expectContract(
      'PATCH',
      path,
      200,
      { token, body: { status: 'ACTIVE' } },
      template,
    );
    assert.equal(active.status, 'ACTIVE');
    // Suspender revocó los refresh tokens: el anterior ya no sirve aunque la cuenta esté activa.
    await expectContract('POST', '/auth/refresh', 401, {
      body: { refreshToken: state.buyerSession.refreshToken },
    });
    state.buyerSession = await login(buyer.email, buyer.password);
  });

  test('admin: sobre su propia cuenta -> 409 CANNOT_MODIFY_SELF', async () => {
    const token = state.admin.accessToken;
    const adminId = state.admin.user.id;
    const status = await expectContract(
      'PATCH',
      `/admin/users/${adminId}/status`,
      409,
      { token, body: { status: 'SUSPENDED' } },
      '/admin/users/{userId}/status',
    );
    assert.equal(status.code, 'CANNOT_MODIFY_SELF');
    const del = await expectContract(
      'DELETE',
      `/admin/users/${adminId}`,
      409,
      { token },
      '/admin/users/{userId}',
    );
    assert.equal(del.code, 'CANNOT_MODIFY_SELF');
  });

  test('POST /admin/organizers -> 201, correo de credenciales en Mailpit, login del organizador', async (t) => {
    const token = state.admin.accessToken;
    const organizer = {
      name: 'Carlos Méndez',
      email: email('organizador'),
      organizationName: 'Producciones Demo S.A. de C.V.',
    };
    const created = await expectContract('POST', '/admin/organizers', 201, {
      token,
      body: organizer,
    });
    assert.equal(created.credentialsEmailSent, true);
    assert.equal(created.user.role, 'ORGANIZER');
    assert.equal(created.user.organizationName, organizer.organizationName);
    assert.equal(created.user.mustChangePassword, true);

    const message = await findEmail(organizer.email);
    t.diagnostic(`Mailpit: "${message.Subject}" para ${message.To.map((to) => to.Address)}`);
    assert.equal(message.Subject, 'Tus credenciales de acceso a TicketHub');
    const tempPassword = await temporaryPasswordFrom(message);

    const session = await login(organizer.email, tempPassword);
    assert.equal(session.user.mustChangePassword, true);
    state.organizer = { ...organizer, id: created.user.id, session };

    await expectContract('POST', '/admin/organizers', 409, { token, body: organizer });
    await expectContract('POST', '/admin/organizers', 400, {
      token,
      body: { name: 'Sin organización', email: email('x') },
    });
    await expectContract('POST', '/admin/organizers', 403, {
      token: state.buyerSession.accessToken,
      body: { ...organizer, email: email('otro') },
    });
  });

  test('organizador da de alta personal; lo ve en /organizer/staff; el personal tiene employerId', async (t) => {
    const token = state.organizer.session.accessToken;
    const staff = { name: 'Luis Pérez', email: email('staff') };
    const created = await expectContract('POST', '/organizer/staff', 201, { token, body: staff });
    assert.equal(created.credentialsEmailSent, true);
    assert.equal(created.user.role, 'STAFF');
    assert.equal(created.user.employerId, state.organizer.id);
    assert.equal(created.user.mustChangePassword, true);

    const message = await findEmail(staff.email);
    t.diagnostic(`Mailpit: "${message.Subject}" para ${message.To.map((to) => to.Address)}`);
    const session = await login(staff.email, await temporaryPasswordFrom(message));
    const claims = jwtPayload(session.accessToken);
    assert.equal(claims.role, 'STAFF');
    assert.equal(claims.employerId, state.organizer.id);

    const list = await expectContract('GET', '/organizer/staff', 200, { token });
    assert.deepEqual(
      list.items.map((u) => u.email),
      [staff.email],
    );
    await expectContract('GET', '/organizer/staff', 403, { token: state.admin.accessToken });
    await expectContract('POST', '/organizer/staff', 409, { token, body: staff });

    // El organizador cambia su contraseña temporal: mustChangePassword pasa a false.
    state.staffId = created.user.id;
  });

  test('organizador cambia la contraseña temporal -> mustChangePassword false', async () => {
    const { session } = state.organizer;
    const tempPassword = await temporaryPasswordFrom(await findEmail(state.organizer.email));
    await expectContract('PUT', '/users/me/password', 204, {
      token: session.accessToken,
      body: { currentPassword: tempPassword, newPassword: 'Organiza!2026' },
    });
    const me = await expectContract('GET', '/users/me', 200, { token: session.accessToken });
    assert.equal(me.mustChangePassword, false);
  });

  test('admin: borrado lógico -> 204; login 401; oculto salvo includeDeleted; correo sigue ocupado', async () => {
    const token = state.admin.accessToken;
    const path = `/admin/users/${state.buyerId}`;
    await expectContract('DELETE', path, 204, { token }, '/admin/users/{userId}');
    await expectContract('DELETE', path, 404, { token }, '/admin/users/{userId}');

    const err = await expectContract('POST', '/auth/login', 401, {
      body: { email: buyer.email, password: buyer.password },
    });
    assert.equal(err.code, 'INVALID_CREDENTIALS');
    await expectContract('POST', '/auth/refresh', 401, {
      body: { refreshToken: state.buyerSession.refreshToken },
    });

    const q = `q=${encodeURIComponent(buyer.email)}`;
    const hidden = await expectContract('GET', `/admin/users?${q}`, 200, { token }, '/admin/users');
    assert.equal(hidden.totalItems, 0);
    const shown = await expectContract(
      'GET',
      `/admin/users?${q}&includeDeleted=true`,
      200,
      { token },
      '/admin/users',
    );
    assert.equal(shown.totalItems, 1);
    assert.match(shown.items[0].deletedAt, /Z$/);

    await expectContract('POST', '/auth/register', 409, { body: buyer });
    await expectContract(
      'DELETE',
      '/admin/users/999999999',
      404,
      { token },
      '/admin/users/{userId}',
    );
  });

  test('/internal directo en identity-service: con X-Internal-Token -> 200; sin él -> 401', async () => {
    const userSchema = responseSchema('GET', '/api/v1/users/me', 200);
    const headers = { 'x-internal-token': INTERNAL_TOKEN };
    const deleted = await call('GET', `/internal/users/${state.buyerId}`, {
      base: IDENTITY,
      headers,
    });
    assert.equal(deleted.res.status, 200);
    assertSchema(userSchema, deleted.body, 'GET /internal/users/{userId}');
    assert.match(deleted.body.deletedAt, /Z$/);

    const staff = await call('GET', `/internal/users/${state.staffId}`, {
      base: IDENTITY,
      headers,
    });
    assert.equal(staff.res.status, 200);
    assert.equal(staff.body.employerId, state.organizer.id);
    assert.equal(staff.body.deletedAt, null);

    const missing = await call('GET', '/internal/users/999999999', { base: IDENTITY, headers });
    assert.equal(missing.res.status, 404);

    for (const h of [{}, { 'x-internal-token': 'incorrecto' }]) {
      const denied = await call('GET', `/internal/users/${state.buyerId}`, {
        base: IDENTITY,
        headers: h,
      });
      assert.equal(denied.res.status, 401);
      assert.equal(denied.body.code, 'UNAUTHORIZED');
    }

    const stats = await call('GET', '/internal/stats/users', { base: IDENTITY, headers });
    assert.equal(stats.res.status, 200);
    assert.deepEqual(Object.keys(stats.body).sort(), ['byRole', 'suspended', 'total']);
    assert.deepEqual(Object.keys(stats.body.byRole).sort(), [
      'ADMIN',
      'BUYER',
      'ORGANIZER',
      'STAFF',
    ]);
    const sum = Object.values(stats.body.byRole).reduce((a, b) => a + b, 0);
    assert.equal(stats.body.total, sum);
    assert.ok(stats.body.byRole.ADMIN >= 1 && stats.body.byRole.STAFF >= 1);
  });
});
