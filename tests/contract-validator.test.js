import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertSchema } from './contract.js';

const seatItem = {
  type: 'object',
  required: ['seatId'],
  additionalProperties: false,
  properties: { seatId: { type: 'integer', minimum: 1 } },
};
const generalItem = {
  type: 'object',
  required: ['zoneId', 'quantity'],
  additionalProperties: false,
  properties: { zoneId: { type: 'integer' }, quantity: { type: 'integer', minimum: 1 } },
};
const item = { oneOf: [seatItem, generalItem] };

const passes = (schema, value) => assertSchema(schema, value, 'prueba');
const fails = (schema, value, pattern) =>
  assert.throws(() => assertSchema(schema, value, 'prueba'), pattern);

describe('validador de schemas de tests/contract.js', () => {
  test('oneOf: acepta un valor que coincide con exactamente una opción', () => {
    passes(item, { seatId: 1 });
    passes(item, { zoneId: 2, quantity: 3 });
    passes({ type: 'array', items: item }, [{ seatId: 1 }, { zoneId: 2, quantity: 1 }]);
  });

  test('oneOf: rechaza un valor que no coincide con ninguna opción', () => {
    fails(item, { seatId: 1, zoneId: 2, quantity: 1 }, /coincide con 0 opciones de oneOf/);
    fails(item, { zoneId: 2 }, /coincide con 0 opciones de oneOf/);
    fails(item, { seatId: 0 }, /coincide con 0 opciones de oneOf/);
    fails({ type: 'array', items: item }, [{ seatId: 1 }, 'x'], /body\[1\]: coincide con 0/);
  });

  test('oneOf: rechaza un valor que coincide con más de una opción', () => {
    fails({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3, /coincide con 2 opciones/);
    passes({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3.5);
  });

  test('anyOf: basta con una opción y falla si no coincide ninguna', () => {
    const schema = { anyOf: [{ type: 'number' }, { type: 'integer' }] };
    passes(schema, 3);
    passes({ anyOf: [{ type: 'string' }, { type: 'boolean' }] }, true);
    fails({ anyOf: [{ type: 'string' }, { type: 'boolean' }] }, 1, /ninguna opción de anyOf/);
  });

  test('oneOf con nullable acepta null; sin nullable lo rechaza', () => {
    passes({ nullable: true, oneOf: [seatItem, generalItem] }, null);
    fails(item, null, /coincide con 0 opciones/);
  });

  test('oneOf dentro de una propiedad', () => {
    const schema = {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: item } },
    };
    passes(schema, { items: [{ seatId: 9 }] });
    fails(schema, { items: [{ quantity: 1 }] }, /body\.items\[0\]/);
  });
});
