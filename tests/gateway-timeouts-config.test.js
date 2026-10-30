import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { serverTimeouts } from '../services/gateway/src/timeouts.js';

describe('GATEWAY_REQUEST_TIMEOUT_SECONDS y GATEWAY_HEADERS_TIMEOUT_SECONDS', () => {
  test('por omisión 60 s para la petición y 15 s para los headers', () => {
    assert.deepEqual(serverTimeouts({}), {
      requestTimeoutMs: 60_000,
      headersTimeoutMs: 15_000,
      checkIntervalMs: 1000,
    });
  });

  test('valores inválidos o headers mayores que la petición impiden arrancar', () => {
    for (const value of ['0', '-1', '2.5', 'abc']) {
      assert.throws(
        () => serverTimeouts({ GATEWAY_REQUEST_TIMEOUT_SECONDS: value }),
        /GATEWAY_REQUEST_TIMEOUT_SECONDS debe ser un entero/,
      );
    }
    assert.throws(
      () =>
        serverTimeouts({
          GATEWAY_REQUEST_TIMEOUT_SECONDS: '10',
          GATEWAY_HEADERS_TIMEOUT_SECONDS: '20',
        }),
      /no puede ser mayor/,
    );
  });
});
