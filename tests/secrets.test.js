import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkSecret } from '../services/common/src/env.js';
import { checkJwtSecret } from '../services/gateway/src/secret.js';

describe('longitud mínima de JWT_SECRET', () => {
  test('common rechaza un secreto ausente o de menos de 32 caracteres', () => {
    assert.throws(() => checkSecret('JWT_SECRET', undefined), /Falta la variable de entorno/);
    assert.throws(() => checkSecret('JWT_SECRET', ''), /Falta la variable de entorno/);
    assert.throws(() => checkSecret('JWT_SECRET', 'a'.repeat(31)), /al menos 32 caracteres/);
    assert.equal(checkSecret('JWT_SECRET', 'a'.repeat(32)), 'a'.repeat(32));
  });

  test('el gateway rechaza un secreto ausente o de menos de 32 caracteres', () => {
    assert.throws(() => checkJwtSecret(undefined), /Falta la variable de entorno JWT_SECRET/);
    assert.throws(() => checkJwtSecret('a'.repeat(31)), /al menos 32 caracteres/);
    assert.equal(checkJwtSecret('a'.repeat(32)), 'a'.repeat(32));
  });
});
