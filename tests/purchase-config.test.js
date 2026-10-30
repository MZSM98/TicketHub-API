import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

const loadConfig = (claimSeconds) =>
  spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import '/app/services/purchase/src/config.js'"],
    {
      env: { PATH: process.env.PATH, INTERNAL_TOKEN: 'x', PAYMENT_CLAIM_SECONDS: claimSeconds },
      encoding: 'utf8',
    },
  );

describe('PAYMENT_CLAIM_SECONDS', () => {
  test('0, negativo o no numérico impide arrancar', () => {
    for (const value of ['0', '-5', 'abc']) {
      const result = loadConfig(value);
      assert.notEqual(result.status, 0, value);
      assert.match(result.stderr, /PAYMENT_CLAIM_SECONDS debe ser mayor que 0/, value);
    }
  });

  test('un valor mayor que 0 se acepta', () => {
    assert.equal(loadConfig('5').status, 0);
  });
});
