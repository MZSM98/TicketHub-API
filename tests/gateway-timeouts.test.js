import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, test } from 'node:test';
import { assertSchema, responseSchema } from './contract.js';

const target = new URL(process.env.GATEWAY_SLOW_URL ?? 'http://localhost:8080/api/v1');

function slowRequest(head, { trickle }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect(Number(target.port), target.hostname);
    let response = '';
    let timer;
    socket.on('connect', () => {
      socket.write(head);
      if (trickle) timer = setInterval(() => socket.write('x'), 500);
    });
    socket.on('data', (chunk) => (response += chunk));
    socket.on('error', () => null);
    socket.on('close', () => {
      clearInterval(timer);
      const [head, body = ''] = response.split('\r\n\r\n');
      resolve({
        elapsed: Date.now() - started,
        status: /^HTTP\/1\.1 (\d{3})/.exec(head)?.[1],
        contentType: /^content-type: (.+)$/im.exec(head)?.[1],
        body,
      });
    });
  });
}

function assertTimeoutJson(result) {
  assert.equal(result.status, '408');
  assert.equal(result.contentType, 'application/json; charset=utf-8');
  const body = JSON.parse(result.body);
  assert.equal(body.code, 'REQUEST_TIMEOUT');
  assertSchema(responseSchema('POST', '/api/v1/auth/login', 408), body, 'RequestTimeout');
  return body;
}

describe('timeouts del gateway contra cuerpos y headers lentos', () => {
  test('un cuerpo que llega byte a byte recibe 408 JSON REQUEST_TIMEOUT al vencer GATEWAY_REQUEST_TIMEOUT_SECONDS', async () => {
    const head =
      `POST ${target.pathname}/auth/login HTTP/1.1\r\nHost: ${target.host}\r\n` +
      'Content-Type: application/json\r\nContent-Length: 50000\r\n\r\n{"email":"';
    const result = await slowRequest(head, { trickle: true });
    const body = assertTimeoutJson(result);
    assert.ok(result.elapsed >= 2500 && result.elapsed < 6000, `cortó en ${result.elapsed} ms`);
    console.log(
      `[cuerpo lento] 408 ${JSON.stringify(body)} a los ${result.elapsed} ms (límite 3 s)`,
    );
  });

  test('headers incompletos reciben 408 JSON al vencer GATEWAY_HEADERS_TIMEOUT_SECONDS', async () => {
    const result = await slowRequest(`GET ${target.pathname}/events HTTP/1.1\r\nHost: x\r\n`, {
      trickle: false,
    });
    const body = assertTimeoutJson(result);
    assert.ok(result.elapsed >= 1500 && result.elapsed < 5000, `cortó en ${result.elapsed} ms`);
    console.log(
      `[headers lentos] 408 ${JSON.stringify(body)} a los ${result.elapsed} ms (límite 2 s)`,
    );
  });
});
