import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, test } from 'node:test';

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
      resolve({ elapsed: Date.now() - started, status: /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] });
    });
  });
}

describe('timeouts del gateway contra cuerpos y headers lentos', () => {
  test('un cuerpo que llega byte a byte se corta con 408 al vencer GATEWAY_REQUEST_TIMEOUT_SECONDS', async () => {
    const head =
      `POST ${target.pathname}/auth/login HTTP/1.1\r\nHost: ${target.host}\r\n` +
      'Content-Type: application/json\r\nContent-Length: 50000\r\n\r\n{"email":"';
    const result = await slowRequest(head, { trickle: true });
    assert.equal(result.status, '408');
    assert.ok(result.elapsed >= 2500 && result.elapsed < 6000, `cortó en ${result.elapsed} ms`);
    console.log(`[cuerpo lento] 408 y cierre a los ${result.elapsed} ms (límite 3 s)`);
  });

  test('headers incompletos se cortan al vencer GATEWAY_HEADERS_TIMEOUT_SECONDS', async () => {
    const result = await slowRequest(`GET ${target.pathname}/events HTTP/1.1\r\nHost: x\r\n`, {
      trickle: false,
    });
    assert.ok(result.elapsed >= 1500 && result.elapsed < 5000, `cortó en ${result.elapsed} ms`);
    console.log(`[headers lentos] cierre a los ${result.elapsed} ms (límite 2 s)`);
  });
});
