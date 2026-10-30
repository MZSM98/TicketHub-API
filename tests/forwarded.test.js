import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rewriteForwarded } from '../services/gateway/src/forwarded.js';
import { parseTrustedProxies } from '../services/gateway/src/trust.js';

const SECRET = 's'.repeat(32);

function rewrite(peer, headers, { trust = '', sendSecret = true, encrypted = false } = {}) {
  const req = { headers: { ...headers }, socket: { remoteAddress: peer, encrypted } };
  rewriteForwarded(req, { secret: SECRET, sendSecret, isTrustedProxy: parseTrustedProxies(trust) });
  return req.headers;
}

describe('TRUST_PROXY y cabeceras reenviadas del gateway', () => {
  test('sin TRUST_PROXY se ignoran X-Forwarded-Proto y X-Forwarded-Host del cliente', () => {
    const headers = rewrite('172.18.0.1', {
      host: 'localhost:18080',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'evil.com',
      forwarded: 'proto=https',
    });
    assert.equal(headers['x-forwarded-proto'], 'http');
    assert.equal(headers['x-forwarded-host'], 'localhost:18080');
    assert.equal(headers.forwarded, undefined);
  });

  test('par de confianza: toma https y el host del túnel; el resto se descarta', () => {
    const headers = rewrite(
      '::ffff:172.18.0.1',
      {
        host: 'gateway:8080',
        'x-forwarded-proto': 'https, http',
        'x-forwarded-host': 'demo.trycloudflare.com',
        'x-real-ip': '1.2.3.4',
        'x-tickethub-gateway': 'falso',
      },
      { trust: '172.16.0.0/12' },
    );
    assert.equal(headers['x-forwarded-proto'], 'https');
    assert.equal(headers['x-forwarded-host'], 'demo.trycloudflare.com');
    assert.equal(headers['x-real-ip'], undefined);
    assert.equal(headers['x-tickethub-gateway'], SECRET);
  });

  test('par de confianza sin X-Forwarded-Host usa el Host; protocolo inválido se ignora', () => {
    const headers = rewrite(
      '10.0.0.7',
      { host: 'abc.ngrok-free.app', 'x-forwarded-proto': 'ftp' },
      { trust: '10.0.0.7' },
    );
    assert.equal(headers['x-forwarded-proto'], 'http');
    assert.equal(headers['x-forwarded-host'], 'abc.ngrok-free.app');
  });

  test('par fuera de los rangos de confianza no cambia el comportamiento', () => {
    const headers = rewrite(
      '192.168.1.50',
      { host: 'h', 'x-forwarded-proto': 'https' },
      { trust: '172.16.0.0/12, 10.0.0.7, ::1' },
    );
    assert.equal(headers['x-forwarded-proto'], 'http');
  });

  test('el secreto solo viaja cuando el servicio lo usa', () => {
    const headers = rewrite(
      '1.1.1.1',
      { host: 'h', 'x-tickethub-gateway': 'falso' },
      { sendSecret: false },
    );
    assert.equal(headers['x-tickethub-gateway'], undefined);
  });

  test('TRUST_PROXY inválido impide arrancar', () => {
    for (const bad of ['10.0.0.0/33', 'abc', '10.0.0.1/8/1', '::/129', '10.0.0.0/x']) {
      assert.throws(() => parseTrustedProxies(bad), /TRUST_PROXY tiene una entrada inválida/, bad);
    }
    assert.equal(parseTrustedProxies('')('127.0.0.1'), false);
  });
});
