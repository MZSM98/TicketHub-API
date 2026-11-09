import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const enabled = process.env.TEST_VM1_STARTUP === '1';
const project = `tickethub-vm1-startup-${process.pid}`;
const octet = process.env.TEST_VM1_SUBNET_OCTET ?? String(16 + (process.pid % 200));
const subnet = `172.31.${octet}`;
let dir;
let envFile;

function compose(...args) {
  return execFileSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      '--env-file',
      envFile,
      '-f',
      'deploy/vm1/docker-compose.yml',
      '-f',
      'tests-host/vm1-startup.compose.yml',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

const probe = `
const res = await fetch('http://127.0.0.1:8080/api/v1/health');
console.log(JSON.stringify({ code: res.status, body: await res.json() }));
`;

function health() {
  try {
    return JSON.parse(compose('exec', '-T', 'gateway', 'node', '--input-type=module', '-e', probe));
  } catch {
    return null;
  }
}

function gatewayState() {
  const id = compose('ps', '-q', 'gateway').trim();
  const [startedAt, restartCount] = execFileSync(
    'docker',
    ['inspect', '-f', '{{.State.StartedAt}} {{.RestartCount}}', id],
    { encoding: 'utf8' },
  )
    .trim()
    .split(' ');
  return { id, startedAt, restartCount: Number(restartCount) };
}

async function waitFor(predicate, ms = 180000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = health();
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.fail(`health no llegó al estado esperado: ${JSON.stringify(last)}`);
}

describe(
  'arranque de vm1 con MySQL de vm2 caído',
  { skip: !enabled && 'requiere TEST_VM1_STARTUP=1' },
  () => {
    let degradedState;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'vm1-startup-'));
      envFile = join(dir, '.env');
      execFileSync('bash', ['deploy/gen-env.sh', envFile]);
      const env = readFileSync(envFile, 'utf8');
      writeFileSync(envFile, `${env}\nVM1_TEST_SUBNET=${subnet}.0/24\nVM2_IP=${subnet}.11\n`);
    });

    after(() => {
      try {
        compose('--profile', 'vm2', 'down', '-v', '--rmi', 'local', '--remove-orphans');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('up del gateway termina bien aunque identity y catalog no estén sanos', () => {
      compose('up', '-d', '--build', 'gateway');
      const state = compose('ps', '--format', '{{.Service}} {{.State}}', 'gateway');
      assert.match(state, /^gateway running/m);
    });

    test('el gateway responde 200 DEGRADED con identity y catalog DOWN', async () => {
      const result = await waitFor((r) => r.code === 200);
      console.log(`health con MySQL caído: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.status, 'DEGRADED');
      assert.equal(result.body.services.identity, 'DOWN');
      assert.equal(result.body.services.catalog, 'DOWN');
      degradedState = gatewayState();
    });

    test('al levantar MySQL identity y catalog vuelven a UP sin reiniciar el gateway', async () => {
      compose('--profile', 'vm2', 'up', '-d', '--wait', 'vm2-mysql');
      const result = await waitFor(
        (r) => r.body.services.identity === 'UP' && r.body.services.catalog === 'UP',
      );
      console.log(`health con MySQL arriba: ${JSON.stringify(result.body)}`);
      assert.equal(result.code, 200);
      const state = gatewayState();
      console.log(
        `gateway antes ${JSON.stringify(degradedState)} después ${JSON.stringify(state)}`,
      );
      assert.deepEqual(state, degradedState);
      assert.equal(state.restartCount, 0);
    });
  },
);
