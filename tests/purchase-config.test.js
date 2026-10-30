import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

const loadConfig = (env) =>
  spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import '/app/services/purchase/src/config.js'"],
    {
      env: { PATH: process.env.PATH, INTERNAL_TOKEN: 'x', ...env },
      encoding: 'utf8',
    },
  );

describe('PAYMENT_CLAIM_SECONDS', () => {
  test('0, negativo, decimal o no numérico impide arrancar', () => {
    for (const value of ['0', '-5', 'abc', '0.5', '12.5', '1e2']) {
      const result = loadConfig({ PAYMENT_CLAIM_SECONDS: value });
      assert.notEqual(result.status, 0, value);
      assert.match(result.stderr, /PAYMENT_CLAIM_SECONDS debe ser un entero de al menos 11/, value);
    }
  });

  test('el mínimo es el primer entero mayor que el timeout más largo de Stripe o interno', () => {
    assert.notEqual(loadConfig({ PAYMENT_CLAIM_SECONDS: '10' }).status, 0);
    assert.equal(loadConfig({ PAYMENT_CLAIM_SECONDS: '11' }).status, 0);
    const short = { STRIPE_TIMEOUT_MS: '1500', INTERNAL_TIMEOUT_MS: '1500' };
    const tooShort = loadConfig({ ...short, PAYMENT_CLAIM_SECONDS: '1' });
    assert.match(tooShort.stderr, /al menos 2 segundos/);
    assert.equal(loadConfig({ ...short, PAYMENT_CLAIM_SECONDS: '2' }).status, 0);
    const internalLonger = loadConfig({
      STRIPE_TIMEOUT_MS: '1500',
      INTERNAL_TIMEOUT_MS: '4000',
      PAYMENT_CLAIM_SECONDS: '4',
    });
    assert.match(internalLonger.stderr, /al menos 5 segundos/);
  });

  test('sin valor se calcula a partir de los timeouts', () => {
    assert.equal(loadConfig({}).status, 0);
  });
});
