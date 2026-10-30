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
        'x-forwarded-proto': 'http, https',
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

  test('listas con coma: se toma el último valor, el que agregó el proxy de confianza', () => {
    const headers = rewrite(
      '10.0.0.7',
      {
        host: 'abc.ngrok-free.app',
        'x-forwarded-proto': 'http, https',
        'x-forwarded-host': 'evil.com, abc.ngrok-free.app',
      },
      { trust: '10.0.0.7' },
    );
    assert.equal(headers['x-forwarded-proto'], 'https');
    assert.equal(headers['x-forwarded-host'], 'abc.ngrok-free.app');
  });

  test('X-Forwarded-Host inválido del proxy de confianza usa el Host válido', () => {
    const invalid = [
      'evil.com/x',
      'user@evil.com',
      'evil.com:99999',
      'evil.com:0',
      'a b',
      '',
      'abc.ngrok-free.app, evil.com/x',
      'http://evil.com',
      '[zz::1]',
    ];
    for (const value of invalid) {
      const headers = rewrite(
        '10.0.0.7',
        { host: 'abc.ngrok-free.app', 'x-forwarded-proto': 'https', 'x-forwarded-host': value },
        { trust: '10.0.0.7' },
      );
      assert.equal(headers['x-forwarded-host'], 'abc.ngrok-free.app', value);
      assert.equal(headers['x-forwarded-proto'], 'https', value);
    }
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
    const invalid = [
      '10.0.0.0/33',
      'abc',
      '10.0.0.1/8/1',
      '::/129',
      '10.0.0.0/x',
      '10.0.0.0/08',
      '010.0.0.1',
      '10.0.0.1:8080',
      '::/0',
      '::/64',
      '::ffff:0:0/96',
      '::ffff:10.0.0.0/104',
      '::ffff:10.0.0.1',
    ];
    for (const bad of invalid) {
      assert.throws(() => parseTrustedProxies(bad), /TRUST_PROXY tiene una entrada inválida/, bad);
    }
    assert.equal(parseTrustedProxies('')('127.0.0.1'), false);
    const trusted = parseTrustedProxies('172.30.0.10, fd00::/8');
    assert.equal(trusted('::ffff:172.30.0.10'), true, 'el par IPv4 llega mapeado en IPv6');
    assert.equal(trusted('fd00::5'), true);
    assert.equal(trusted('172.30.0.11'), false);
  });
});
