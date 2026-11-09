import assert from 'node:assert/strict';
import http from 'node:http';
import { before, describe, test } from 'node:test';
import { parseAllowedHosts, parseHost, publicBaseUrl } from '../services/common/src/public-url.js';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  CATALOG,
  createOrganizer,
  expectContract,
  GATEWAY,
  login,
  RUN,
} from './helpers.js';

const FALLBACK = (process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080/api/v1').replace(/\/$/, '');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function rawGet(base, path, headers) {
  const url = new URL(`${base}${path}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('URLs absolutas según el host de cada petición', () => {
  const s = {};
  const poster = () => `/events/${s.eventId}/poster`;
  const getEvent = (base, headers) =>
    rawGet(base, `/api/v1/events/${s.eventId}`, {
      authorization: `Bearer ${s.token}`,
      ...headers,
    });

  before(async () => {
    const admin = (await login(ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    s.token = (await createOrganizer(admin, 'url-org')).token;
    const venue = await expectContract('POST', '/venues', 201, {
      token: s.token,
      body: { name: `Foro URL ${RUN}`, address: 'Calle 9', city: 'León' },
    });
    const event = await expectContract('POST', '/events', 201, {
      token: s.token,
      body: {
        venueId: venue.id,
        title: `URLs ${RUN}`,
        description: 'Evento para probar URLs por host.',
        category: 'CONCERT',
        startsAt: new Date(Date.now() + 20 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z'),
      },
    });
    s.eventId = event.id;
    const data = new FormData();
    data.append('file', new Blob([PNG], { type: 'image/png' }), 'p.png');
    const res = await fetch(`${GATEWAY}${poster()}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${s.token}` },
      body: data,
    });
    assert.equal(res.status, 200);
    s.gatewayOrigin = new URL(GATEWAY).origin;
    s.catalogOrigin = new URL(CATALOG).origin;
  });

  test('Host localhost:18080 -> posterUrl con localhost:18080', async () => {
    const { status, body } = await getEvent(s.gatewayOrigin, { host: 'localhost:18080' });
    assert.equal(status, 200);
    assert.equal(body.posterUrl, `http://localhost:18080/api/v1${poster()}`);
  });

  test('Host 10.0.2.2:18080 (emulador Android) -> posterUrl con 10.0.2.2', async () => {
    const { body } = await getEvent(s.gatewayOrigin, { host: '10.0.2.2:18080' });
    assert.equal(body.posterUrl, `http://10.0.2.2:18080/api/v1${poster()}`);
    const lan = await getEvent(s.gatewayOrigin, { host: '192.168.1.50:18080' });
    assert.equal(lan.body.posterUrl, `http://192.168.1.50:18080/api/v1${poster()}`);
  });

  test('X-Forwarded-Host, Forwarded y X-Forwarded-Proto del cliente se ignoran', async () => {
    const { body } = await getEvent(s.gatewayOrigin, {
      host: 'localhost:18080',
      'x-forwarded-host': 'evil.com',
      'x-forwarded-proto': 'https',
      forwarded: 'host=evil.com;proto=https',
      'x-tickethub-gateway': 'falso',
    });
    assert.equal(body.posterUrl, `http://localhost:18080/api/v1${poster()}`);
  });

  test('detrás de un túnel de confianza (TRUST_PROXY) -> https y el host público del túnel', async () => {
    const trusted = new URL(process.env.GATEWAY_TRUSTED_URL ?? GATEWAY).origin;
    const tunnel = await getEvent(trusted, {
      host: 'demo.trycloudflare.com',
      'x-forwarded-proto': 'https',
    });
    assert.equal(tunnel.body.posterUrl, `https://demo.trycloudflare.com/api/v1${poster()}`);
    const rewritten = await getEvent(trusted, {
      host: 'gateway:8080',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'abc.ngrok-free.app',
    });
    assert.equal(rewritten.body.posterUrl, `https://abc.ngrok-free.app/api/v1${poster()}`);
    const untrusted = await getEvent(s.gatewayOrigin, {
      host: 'demo.trycloudflare.com',
      'x-forwarded-proto': 'https',
    });
    assert.equal(untrusted.body.posterUrl, `http://demo.trycloudflare.com/api/v1${poster()}`);
  });

  test('Host inválido -> PUBLIC_BASE_URL', async () => {
    for (const host of ['evil.com/ruta', 'user@evil.com', 'bad_host!:80', 'localhost:99999']) {
      const { status, body } = await getEvent(s.gatewayOrigin, { host });
      assert.equal(status, 200, host);
      assert.equal(body.posterUrl, `${FALLBACK}${poster()}`, host);
    }
  });

  test('directo al servicio sin gateway -> PUBLIC_BASE_URL aunque mande X-Forwarded-Host', async () => {
    const plain = await getEvent(s.catalogOrigin, {});
    assert.equal(plain.body.posterUrl, `${FALLBACK}${poster()}`);
    const forged = await getEvent(s.catalogOrigin, {
      'x-forwarded-host': 'evil.com',
      'x-forwarded-proto': 'http',
      'x-tickethub-gateway': 'secreto-adivinado-de-al-menos-32-caracteres',
    });
    assert.equal(forged.body.posterUrl, `${FALLBACK}${poster()}`);
  });

  test('unidad: validación de host, protocolo y lista permitida', () => {
    for (const ok of [
      'localhost',
      'localhost:18080',
      '10.0.2.2:18080',
      'api.example.com',
      '[::1]:8080',
    ]) {
      assert.ok(parseHost(ok), ok);
    }
    for (const bad of [
      '',
      'a b',
      'h/p',
      'u@h',
      'h:0',
      'h:65536',
      'h?x',
      'h#x',
      '-a.com',
      'a..b',
      'h:80:81',
    ]) {
      assert.equal(parseHost(bad), null, bad);
    }
    const secret = 's'.repeat(32);
    const fwd = (host, proto = 'http', sent = secret) => ({
      'x-forwarded-host': host,
      'x-forwarded-proto': proto,
      'x-tickethub-gateway': sent,
    });
    const opts = { fallback: 'http://fb/api/v1', gatewaySecret: secret };
    assert.equal(publicBaseUrl(fwd('Phone.Lan:8080'), opts), 'http://phone.lan:8080/api/v1');
    assert.equal(publicBaseUrl(fwd('h', 'https'), opts), 'https://h/api/v1');
    assert.equal(publicBaseUrl(fwd('h', 'ftp'), opts), 'http://fb/api/v1');
    assert.equal(publicBaseUrl(fwd('h', 'http', 'otro'), opts), 'http://fb/api/v1');
    assert.equal(publicBaseUrl({}, opts), 'http://fb/api/v1');
    const allow = { ...opts, allowedHosts: parseAllowedHosts('localhost, 10.0.2.2') };
    assert.equal(publicBaseUrl(fwd('10.0.2.2:18080'), allow), 'http://10.0.2.2:18080/api/v1');
    assert.equal(publicBaseUrl(fwd('evil.com'), allow), 'http://fb/api/v1');
  });

  test('unidad: rangos CIDR en PUBLIC_HOSTS_ALLOWED junto con nombres', () => {
    const secret = 's'.repeat(32);
    const fwd = (host) => ({
      'x-forwarded-host': host,
      'x-forwarded-proto': 'http',
      'x-tickethub-gateway': secret,
    });
    const opts = {
      fallback: 'http://fb/api/v1',
      gatewaySecret: secret,
      allowedHosts: parseAllowedHosts('localhost, 192.168.0.0/16, 10.0.0.0/8, fd00::/8'),
    };
    const cases = {
      '192.168.1.50:18080': 'http://192.168.1.50:18080/api/v1',
      '10.0.2.2:18080': 'http://10.0.2.2:18080/api/v1',
      'localhost:18080': 'http://localhost:18080/api/v1',
      '[fd00::1]:8080': 'http://[fd00::1]:8080/api/v1',
      '172.16.0.5:18080': 'http://fb/api/v1',
      '192.169.0.1': 'http://fb/api/v1',
      'evil.com': 'http://fb/api/v1',
    };
    for (const [host, expected] of Object.entries(cases)) {
      assert.equal(publicBaseUrl(fwd(host), opts), expected, host);
    }
    for (const bad of ['10.0.0.0/33', 'abc/8', '10.0.0/8', '::/129', '192.168.0.0/']) {
      assert.throws(() => parseAllowedHosts(`localhost,${bad}`), /rango inválido/, bad);
    }
  });

  test('unidad: ceros a la izquierda, ip:puerto y rangos IPv4 mapeados en IPv6 impiden arrancar', () => {
    const invalidRanges = [
      '10.0.0.0/08',
      '010.0.0.0/8',
      '10.0.0.0/008',
      '::/0',
      '::/80',
      '::ffff:0:0/96',
      '::ffff:192.168.0.0/112',
      '::ffff:c0a8:0/120',
    ];
    for (const bad of invalidRanges) {
      assert.throws(() => parseAllowedHosts(`localhost,${bad}`), /rango inválido/, bad);
    }
    for (const bad of ['192.168.1.5:8080', 'localhost:8080', '[::1]:8080', '[::ffff:10.0.0.1]']) {
      assert.throws(() => parseAllowedHosts(`localhost,${bad}`), /entrada inválida/, bad);
    }
    assert.equal(parseAllowedHosts('2001:db8::/32, [::1], 0.0.0.0/0, localhost').empty, false);
  });

  test('unidad: un Host IPv4 mapeado en IPv6 no equivale a la IPv4 permitida', () => {
    const secret = 's'.repeat(32);
    const opts = {
      fallback: 'http://fb/api/v1',
      gatewaySecret: secret,
      allowedHosts: parseAllowedHosts('192.168.0.0/16'),
    };
    const url = (host) =>
      publicBaseUrl(
        { 'x-forwarded-host': host, 'x-forwarded-proto': 'http', 'x-tickethub-gateway': secret },
        opts,
      );
    assert.equal(url('192.168.1.1:8080'), 'http://192.168.1.1:8080/api/v1');
    for (const host of [
      '[::ffff:192.168.1.1]:8080',
      '[::ffff:c0a8:101]',
      '[0:0:0:0:0:ffff:c0a8:101]',
    ]) {
      assert.equal(url(host), 'http://fb/api/v1', host);
    }
  });
});
