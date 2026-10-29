import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { assertSchema, responseSchema } from './contract.js';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  CATALOG,
  IDENTITY,
  INVENTORY,
  call,
  email,
  login,
} from './helpers.js';

const errorSchema = responseSchema('POST', '/api/v1/auth/login', 400);
const huge = 'x'.repeat(2 * 1024 * 1024);

async function expectTooLarge(method, path, options) {
  const { res, body } = await call(method, path, options);
  assert.equal(res.status, 413, `${method} ${path}: ${JSON.stringify(body)}`);
  assertSchema(errorSchema, body, `${method} ${path} 413`);
  assert.equal(body.code, 'PAYLOAD_TOO_LARGE');
}

describe('cuerpos mayores al límite', () => {
  let token;
  before(async () => {
    token = (await login(ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
  });

  test('POST /auth/login por el gateway con una contraseña de 2 MB responde 413', () =>
    expectTooLarge('POST', '/auth/login', { body: { email: email('grande'), password: huge } }));

  test('IdentityService directo también responde 413', () =>
    expectTooLarge('POST', '/auth/login', {
      base: IDENTITY,
      body: { email: email('grande'), password: huge },
    }));

  test('CatalogService responde 413 por el gateway y directo', async () => {
    await expectTooLarge('POST', '/venues', { token, body: { name: huge } });
    await expectTooLarge('POST', '/venues', { base: CATALOG, token, body: { name: huge } });
  });

  test('InventoryService responde 413 por el gateway y directo', async () => {
    await expectTooLarge('POST', '/reservations', { token, body: { items: [], pad: huge } });
    await expectTooLarge('POST', '/reservations', { base: INVENTORY, token, body: { pad: huge } });
  });

  test('un cuerpo dentro del límite sigue llegando al servicio', async () => {
    const { res } = await call('POST', '/auth/login', {
      body: { email: email('normal'), password: 'x'.repeat(50 * 1024) },
    });
    assert.notEqual(res.status, 413);
    assert.ok(res.status < 500, `status ${res.status}`);
  });
});
