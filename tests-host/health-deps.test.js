import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, describe, test } from 'node:test';

const project = process.env.TEST_COMPOSE_PROJECT;
const DB_SERVICES = ['identity', 'catalog', 'inventory', 'purchase'];
const BOUND_MS = 2500;

function compose(...args) {
  return execFileSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.test.yml',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

const probe = `
const started = Date.now();
const res = await fetch(process.argv[1]);
const text = await res.text();
console.log(JSON.stringify({ code: res.status, ms: Date.now() - started, body: JSON.parse(text) }));
`;

function get(url) {
  return JSON.parse(
    compose('exec', '-T', 'gateway', 'node', '--input-type=module', '-e', probe, url),
  );
}

const health = () => get('http://127.0.0.1:8080/api/v1/health');

async function waitFor(predicate) {
  const deadline = Date.now() + 90000;
  let last;
  while (Date.now() < deadline) {
    last = health();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.fail(`health no llegó al estado esperado: ${JSON.stringify(last)}`);
}

describe(
  'health con MySQL y MinIO detenidos',
  { skip: !project && 'requiere TEST_COMPOSE_PROJECT' },
  () => {
    after(() => compose('start', 'mysql', 'minio'));

    test('con todo arriba responde 200 y status UP', async () => {
      const result = await waitFor((r) => r.body.status === 'UP');
      assert.equal(result.code, 200);
    });

    test('con mysql detenido responde 200, DEGRADED y DOWN en los servicios con base de datos', async () => {
      compose('stop', 'mysql');
      const result = health();
      console.log(`health con mysql detenido: ${result.ms} ms ${JSON.stringify(result.body)}`);
      assert.equal(result.code, 200);
      assert.equal(result.body.status, 'DEGRADED');
      for (const name of DB_SERVICES) assert.equal(result.body.services[name], 'DOWN');
      assert.equal(result.body.services.ticket, 'UP');
      assert.ok(result.ms < BOUND_MS, `tardó ${result.ms} ms`);
      const internal = get('http://identity-service:3001/health');
      console.log(
        `health interno de identity: ${internal.ms} ms ${internal.code} ${JSON.stringify(internal.body)}`,
      );
      assert.equal(internal.code, 503);
      assert.deepEqual(internal.body, { status: 'DOWN', service: 'identity' });
    });

    test('con mysql arriba otra vez vuelve a UP', async () => {
      compose('start', 'mysql');
      const result = await waitFor((r) => r.body.status === 'UP');
      assert.equal(result.code, 200);
    });

    test('con minio detenido responde 200, DEGRADED y catalog DOWN', async () => {
      compose('stop', 'minio');
      const result = health();
      console.log(`health con minio detenido: ${result.ms} ms ${JSON.stringify(result.body)}`);
      assert.equal(result.code, 200);
      assert.equal(result.body.status, 'DEGRADED');
      assert.equal(result.body.services.catalog, 'DOWN');
      for (const name of ['identity', 'inventory', 'purchase', 'ticket'])
        assert.equal(result.body.services[name], 'UP');
      assert.ok(result.ms < BOUND_MS, `tardó ${result.ms} ms`);
      compose('start', 'minio');
      await waitFor((r) => r.body.status === 'UP');
    });
  },
);
