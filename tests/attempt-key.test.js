import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildAttemptKey, keyNamespace } from '../services/purchase/src/attempt-key.js';

const namespaceOf = (key, reservationId = 5, attempt = 1) =>
  keyNamespace({ idempotency_key: key, reservation_id: reservationId, attempt });

describe('namespace de la llave de idempotencia', () => {
  test('sale de la llave guardada, no de la configuración actual', () => {
    assert.equal(namespaceOf(buildAttemptKey('despliegue-a', 5, 1)), 'despliegue-a');
    assert.equal(namespaceOf(buildAttemptKey('0f3a9c', 5, 2), 5, 2), '0f3a9c');
    assert.equal(
      namespaceOf(buildAttemptKey('x-reservation-5-attempt-1', 5, 1)),
      'x-reservation-5-attempt-1',
    );
  });

  test('una llave vieja sin namespace no tiene despliegue', () => {
    assert.equal(namespaceOf('tickethub-reservation-5-attempt-1'), null);
  });

  test('una llave de otra reserva, otro intento o con namespace inválido no tiene despliegue', () => {
    assert.equal(namespaceOf(buildAttemptKey('a', 6, 1)), null);
    assert.equal(namespaceOf(buildAttemptKey('a', 5, 2)), null);
    assert.equal(namespaceOf(buildAttemptKey('Prod', 5, 1)), null);
    assert.equal(namespaceOf('otro-a-reservation-5-attempt-1'), null);
  });
});
