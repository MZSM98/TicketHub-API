import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, test } from 'node:test';
import { GATEWAY } from './helpers.js';

const target = new URL(`${GATEWAY}/auth/login`);

function rawRequest(headers, writeBody) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        );
      },
    );
    let answered = false;
    req.on('response', () => {
      answered = true;
      req.answered = true;
    });
    req.on('error', (err) => {
      if (!answered && !['ECONNRESET', 'EPIPE'].includes(err.code)) reject(err);
    });
    req.on('close', () => {
      if (!answered) reject(new Error('el gateway cerró sin responder'));
    });
    writeBody(req);
  });
}

describe('límite de 100 KB en el gateway', () => {
  test('Content-Length mayor a 100 KB responde 413 sin esperar el cuerpo', async () => {
    const started = Date.now();
    const result = await rawRequest({ 'content-length': String(5 * 1024 * 1024) }, (req) =>
      req.write('{"email":"'),
    );
    assert.equal(result.status, 413);
    assert.equal(result.body.code, 'PAYLOAD_TOO_LARGE');
    assert.deepEqual(result.body.details, { limit: 102400 });
    assert.ok(Date.now() - started < 3000);
  });

  test('cuerpo chunked sin Content-Length se corta al pasar 100 KB', async () => {
    let sent = 0;
    const result = await rawRequest({ 'transfer-encoding': 'chunked' }, (req) => {
      const chunk = Buffer.alloc(16 * 1024, 'x');
      const pump = () => {
        if (req.destroyed) return;
        if (req.answered) return req.end();
        if (sent >= 64 * 1024 * 1024) return req.end();
        sent += chunk.length;
        if (!req.write(chunk)) return req.once('drain', pump);
        setImmediate(pump);
      };
      pump();
    });
    assert.equal(result.status, 413);
    assert.equal(result.body.code, 'PAYLOAD_TOO_LARGE');
    assert.ok(sent < 64 * 1024 * 1024, `el gateway cortó el stream (enviados ${sent} bytes)`);
  });

  test('cuerpo chunked dentro del límite llega al servicio', async () => {
    const body = JSON.stringify({ email: 'nadie@example.com', password: 'x'.repeat(60 * 1024) });
    const result = await rawRequest({ 'transfer-encoding': 'chunked' }, (req) => {
      req.write(body.slice(0, 1000));
      req.end(body.slice(1000));
    });
    assert.notEqual(result.status, 413);
    assert.ok(result.status < 500, `status ${result.status}`);
  });
});
