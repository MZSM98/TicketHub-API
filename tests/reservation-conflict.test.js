import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { insertUnlessActive } from '../services/inventory/src/active-conflict.js';

const duplicate = () => Object.assign(new Error('Duplicate entry'), { errno: 1062 });

function inserts(...steps) {
  return mock.fn(async () => {
    const step = steps.shift();
    if (step instanceof Error) throw step;
    return step;
  });
}

const lookups = (...ids) => mock.fn(async () => (ids.length > 0 ? ids.shift() : null));

describe('conflicto de reserva activa del mismo comprador', () => {
  test('si la ganadora se cancela entre el duplicado y la consulta, se reintenta y se crea la reserva', async () => {
    const insert = inserts(duplicate(), 42);
    const lookup = lookups(null);
    assert.deepEqual(await insertUnlessActive(insert, lookup, 3), { id: 42 });
    assert.equal(insert.mock.callCount(), 2);
    assert.equal(lookup.mock.callCount(), 1);
  });

  test('si la ganadora sigue activa, devuelve su id para el 409', async () => {
    const insert = inserts(duplicate());
    assert.deepEqual(await insertUnlessActive(insert, lookups(7), 3), { activeId: 7 });
    assert.equal(insert.mock.callCount(), 1);
  });

  test('si la ganadora desaparece en todas las rondas, se agota sin devolver un id nulo', async () => {
    const insert = inserts(duplicate(), duplicate(), duplicate());
    assert.deepEqual(await insertUnlessActive(insert, lookups(null, null, null), 3), {
      exhausted: true,
    });
    assert.equal(insert.mock.callCount(), 3);
  });

  test('otros errores de la inserción se propagan sin consultar', async () => {
    const boom = new Error('otro');
    const lookup = lookups(7);
    await assert.rejects(insertUnlessActive(inserts(boom), lookup, 3), boom);
    assert.equal(lookup.mock.callCount(), 0);
  });
});
