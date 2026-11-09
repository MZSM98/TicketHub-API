import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { schemaError, schemaProblems } from '../services/purchase/src/schema.js';

const current = [
  { table: 'purchases', column: 'ticket_issuance', type: "enum('PENDING','ISSUED','FAILED')" },
  {
    table: 'payment_attempts',
    column: 'status',
    type: "enum('PENDING','AUTHORIZED','CAPTURED','CAPTURE_FAILED','DECLINED','FAILED','CANCEL_PENDING','CANCELED','REFUND_PENDING','REFUNDED','RECOVERY_FAILED')",
  },
  { table: 'payment_attempts', column: 'recovery_attempts', type: 'smallint unsigned' },
];

describe('esquema de PurchaseService al arrancar', () => {
  test('el esquema actual no tiene problemas', () => {
    assert.deepEqual(schemaProblems(current), []);
  });

  test('un esquema viejo se detecta y el mensaje dice cómo arreglarlo', () => {
    const old = [
      { table: 'purchases', column: 'ticket_issuance', type: "enum('PENDING','ISSUED')" },
      {
        table: 'payment_attempts',
        column: 'status',
        type: "enum('PENDING','AUTHORIZED','CAPTURED','CANCELED')",
      },
    ];
    const problems = schemaProblems(old);
    assert.deepEqual(problems, [
      "purchases.ticket_issuance no admite 'FAILED'",
      "payment_attempts.status no admite 'RECOVERY_FAILED'",
      'falta la columna payment_attempts.recovery_attempts',
    ]);
    assert.match(schemaError(problems).message, /down -v/);
    assert.match(schemaError(problems).message, /04-purchase\.sql/);
  });
});
