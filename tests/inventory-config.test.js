import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

const loadConfig = (value) =>
  spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import '/app/services/inventory/src/config.js'"],
    {
      env: { PATH: process.env.PATH, INTERNAL_TOKEN: 'x', MAX_TICKETS_PER_RESERVATION: value },
      encoding: 'utf8',
    },
  );

describe('MAX_TICKETS_PER_RESERVATION', () => {
  test('fuera de 1..10 o no entero impide arrancar', () => {
    for (const value of ['0', '11', '-1', '2.5', 'abc', '1e1']) {
      const result = loadConfig(value);
      assert.notEqual(result.status, 0, value);
      assert.match(
        result.stderr,
        /MAX_TICKETS_PER_RESERVATION debe ser un entero entre 1 y 10/,
        value,
      );
    }
  });

  test('de 1 a 10 se acepta y vacío usa 10', () => {
    for (const value of ['1', '5', '10', '']) assert.equal(loadConfig(value).status, 0, value);
  });
});
