import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { expectContract } from './helpers.js';

const DEGRADED = process.env.GATEWAY_DEGRADED_URL ?? 'http://localhost:8080/api/v1';

describe('health del gateway', () => {
  test('con todos los servicios arriba responde 200 y status UP', async () => {
    const body = await expectContract('GET', '/health', 200);
    assert.equal(body.status, 'UP');
    assert.ok(Object.values(body.services).every((s) => s === 'UP'));
  });

  test('con un servicio caído responde 200 y status DEGRADED', async () => {
    const body = await expectContract('GET', '/health', 200, { base: DEGRADED });
    assert.equal(body.status, 'DEGRADED');
    assert.equal(body.services.ticket, 'DOWN');
    assert.equal(body.services.identity, 'UP');
  });
});
