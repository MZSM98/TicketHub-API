import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { assertContract, assertSchema, responseSchema } from './contract.js';
import { fakes, startFakes } from './fakes.js';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  call,
  CATALOG,
  createOrganizer,
  createStaff,
  email,
  expectContract,
  GATEWAY,
  IDENTITY,
  INTERNAL_TOKEN,
  login,
  RUN,
} from './helpers.js';

const ERROR_SCHEMA = responseSchema('POST', '/api/v1/events', 400);
const EVENT_SCHEMA = responseSchema('GET', '/api/v1/events/{eventId}', 200);
const ASSIGNMENT_SCHEMA = responseSchema('PUT', '/api/v1/events/{eventId}/staff/{userId}', 200);
const internal = { 'x-internal-token': INTERNAL_TOKEN };

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

function form(fields) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value instanceof Blob) data.append(name, value, `${name}.bin`);
    else data.append(name, value);
  }
  return data;
}

async function upload(path, token, body) {
  const headers = { authorization: `Bearer ${token}` };
  if (typeof body === 'string') headers['content-type'] = 'application/json';
  const res = await fetch(`${GATEWAY}${path}`, { method: 'PUT', headers, body });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

const inDays = (days) =>
  new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');

function assertError(res, body, status, code) {
  assert.equal(res.status, status, JSON.stringify(body));
  assertSchema(ERROR_SCHEMA, body, `${status} ${code}`);
  assert.equal(body.code, code);
}

describe('CatalogService (catalog.yaml)', () => {
  const s = {};
  let fakeServer;
  const ev = (suffix = '') => `/events/{eventId}${suffix}`;

  before(async () => {
    fakeServer = await startFakes(Number(process.env.FAKES_PORT ?? 4100), INTERNAL_TOKEN);
    s.admin = (await login(ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    s.orgA = await createOrganizer(s.admin, 'org-a');
    s.orgB = await createOrganizer(s.admin, 'org-b');
    s.staffA = await createStaff(s.orgA.token, 'staff-a');
    s.staffB = await createStaff(s.orgB.token, 'staff-b');
    const buyer = { name: 'Comprador', email: email('cat-buyer'), password: 'S3gura!2026' };
    s.buyerId = (await expectContract('POST', '/auth/register', 201, { body: buyer })).id;
    s.buyer = (await login(buyer.email, buyer.password)).accessToken;
  });

  after(() => fakeServer?.close());

  describe('Recintos', () => {
    const venue = { name: `Auditorio ${RUN}`, address: 'Av. Siempre Viva 742', city: 'Zapopan' };

    test('POST /venues: ORGANIZER y ADMIN -> 201; BUYER y STAFF -> 403; sin token -> 401', async () => {
      const created = await expectContract('POST', '/venues', 201, {
        token: s.orgA.token,
        body: { ...venue, name: `  ${venue.name}  ` },
      });
      assert.deepEqual(created, { id: created.id, ...venue });
      s.venue = created;
      const byAdmin = await expectContract('POST', '/venues', 201, {
        token: s.admin,
        body: { name: `Foro ${RUN}`, address: 'Calle 1', city: 'Guadalajara' },
      });
      s.spareVenue = byAdmin;
      for (const token of [s.buyer, s.staffA.token]) {
        const err = await expectContract('POST', '/venues', 403, { token, body: venue });
        assert.equal(err.code, 'FORBIDDEN');
      }
      await expectContract('POST', '/venues', 401, { body: venue });
    });

    test('POST /venues inválido -> 400 con los campos', async () => {
      const err = await expectContract('POST', '/venues', 400, {
        token: s.orgA.token,
        body: { name: '   ', address: 'x'.repeat(256), city: 5 },
      });
      assert.deepEqual(err.details.fields, [
        { field: 'name', issue: 'too_short' },
        { field: 'address', issue: 'too_long' },
        { field: 'city', issue: 'invalid_type' },
      ]);
    });

    test('recintos sin dueño: otro ORGANIZER y ADMIN los editan; GET por id; 404', async () => {
      const path = `/venues/${s.venue.id}`;
      const edited = await expectContract(
        'PUT',
        path,
        200,
        { token: s.orgB.token, body: { ...venue, address: 'Nueva dirección 1' } },
        '/venues/{venueId}',
      );
      assert.equal(edited.address, 'Nueva dirección 1');
      await expectContract('PUT', path, 200, { token: s.admin, body: venue }, '/venues/{venueId}');
      const got = await expectContract(
        'GET',
        path,
        200,
        { token: s.orgB.token },
        '/venues/{venueId}',
      );
      assert.deepEqual(got, s.venue);
      const missing = await expectContract(
        'GET',
        '/venues/999999999',
        404,
        { token: s.admin },
        '/venues/{venueId}',
      );
      assert.equal(missing.code, 'VENUE_NOT_FOUND');
      await expectContract(
        'PUT',
        '/venues/999999999',
        404,
        { token: s.admin, body: venue },
        '/venues/{venueId}',
      );
      await expectContract('GET', path, 403, { token: s.buyer }, '/venues/{venueId}');
    });

    test('GET /venues: filtros q y city, paginación', async () => {
      const page = await expectContract(
        'GET',
        `/venues?q=${RUN}&pageSize=1`,
        200,
        {
          token: s.orgA.token,
        },
        '/venues',
      );
      assert.equal(page.totalItems, 2);
      assert.equal(page.totalPages, 2);
      assert.equal(page.items.length, 1);
      const byCity = await expectContract(
        'GET',
        `/venues?q=${RUN}&city=zapopan`,
        200,
        {
          token: s.admin,
        },
        '/venues',
      );
      assert.deepEqual(
        byCity.items.map((v) => v.id),
        [s.venue.id],
      );
      const bad = await expectContract(
        'GET',
        '/venues?pageSize=500',
        400,
        { token: s.admin },
        '/venues',
      );
      assert.deepEqual(bad.details.fields, [{ field: 'pageSize', issue: 'invalid_value' }]);
      await expectContract('GET', '/venues', 403, { token: s.staffA.token });
    });

    test('DELETE /venues: solo ADMIN; sin eventos -> 204; luego 404', async () => {
      const path = `/venues/${s.spareVenue.id}`;
      const err = await expectContract(
        'DELETE',
        path,
        403,
        { token: s.orgA.token },
        '/venues/{venueId}',
      );
      assert.equal(err.code, 'FORBIDDEN');
      await expectContract('DELETE', path, 204, { token: s.admin }, '/venues/{venueId}');
      const gone = await expectContract(
        'DELETE',
        path,
        404,
        { token: s.admin },
        '/venues/{venueId}',
      );
      assert.equal(gone.code, 'VENUE_NOT_FOUND');
    });
  });

  describe('Eventos', () => {
    const input = () => ({
      venueId: s.venue.id,
      title: `Noche de Rock ${RUN}`,
      description: 'Concierto con bandas invitadas.',
      category: 'CONCERT',
      startsAt: inDays(30),
    });

    test('POST /events: ORGANIZER -> 201 DRAFT con organizerId del token; otros roles -> 403', async () => {
      const body = input();
      const event = await expectContract('POST', '/events', 201, { token: s.orgA.token, body });
      assert.equal(event.status, 'DRAFT');
      assert.equal(event.organizerId, s.orgA.id);
      assert.equal(event.startsAt, body.startsAt);
      assert.equal(event.posterUrl, null);
      assert.deepEqual(event.venue, s.venue);
      s.event = event;
      s.event2 = await expectContract('POST', '/events', 201, {
        token: s.orgA.token,
        body: { ...body, title: `Festival ${RUN}`, category: 'FESTIVAL', startsAt: inDays(60) },
      });
      s.eventB = await expectContract('POST', '/events', 201, {
        token: s.orgB.token,
        body: { ...body, title: `Teatro ${RUN}`, category: 'THEATER' },
      });
      for (const token of [s.admin, s.buyer, s.staffA.token]) {
        const err = await expectContract('POST', '/events', 403, { token, body });
        assert.equal(err.code, 'FORBIDDEN');
      }
    });

    test('POST /events inválido -> 400; recinto inexistente -> 404 VENUE_NOT_FOUND', async () => {
      const token = s.orgA.token;
      const past = await expectContract('POST', '/events', 400, {
        token,
        body: { ...input(), startsAt: inDays(-1) },
      });
      assert.deepEqual(past.details.fields, [{ field: 'startsAt', issue: 'not_in_future' }]);
      assert.equal(past.message, 'La fecha del evento debe ser futura');
      const bad = await expectContract('POST', '/events', 400, {
        token,
        body: {
          venueId: '3',
          title: 'x',
          description: 'y',
          category: 'OPERA',
          startsAt: '2030-01-01',
        },
      });
      assert.deepEqual(bad.details.fields, [
        { field: 'venueId', issue: 'invalid_type' },
        { field: 'category', issue: 'invalid_value' },
        { field: 'startsAt', issue: 'invalid_format' },
      ]);
      const missing = await expectContract('POST', '/events', 400, { token, body: {} });
      assert.equal(missing.message, 'Por favor llene todos los campos requeridos');
      assert.equal(missing.details.fields.length, 5);
      const noVenue = await expectContract('POST', '/events', 404, {
        token,
        body: { ...input(), venueId: 999999999 },
      });
      assert.equal(noVenue.code, 'VENUE_NOT_FOUND');
    });

    test('GET /events/{id} DRAFT: 404 para anónimo, BUYER y otro ORGANIZER; 200 para dueño y ADMIN', async () => {
      const path = `/events/${s.event.id}`;
      for (const token of [undefined, s.buyer, s.orgB.token]) {
        const err = await expectContract('GET', path, 404, { token }, ev());
        assert.equal(err.code, 'EVENT_NOT_FOUND');
      }
      for (const token of [s.orgA.token, s.admin]) {
        assert.deepEqual(await expectContract('GET', path, 200, { token }, ev()), s.event);
      }
      await call('GET', path, { token: 'no-es-un-jwt' }).then(({ res }) =>
        assert.equal(res.status, 401),
      );
      await expectContract('GET', '/events/999999999', 404, {}, ev());
    });

    test('propiedad del evento: otro ORGANIZER -> 403 NOT_EVENT_OWNER; otros roles -> 403 FORBIDDEN', async () => {
      const path = `/events/${s.event.id}`;
      const calls = [
        ['PUT', path, ev(), input()],
        ['DELETE', path, ev()],
        ['PATCH', `${path}/status`, ev('/status'), { status: 'CANCELLED' }],
        ['GET', `${path}/staff`, ev('/staff')],
        ['PUT', `${path}/staff/${s.staffB.id}`, ev('/staff/{userId}')],
        ['DELETE', `${path}/staff/${s.staffB.id}`, ev('/staff/{userId}')],
        ['PUT', `${path}/poster`, ev('/poster')],
      ];
      for (const [method, url, template, body] of calls) {
        const { res, body: err } = await call(method, url, { token: s.orgB.token, body });
        assertError(res, err, 403, 'NOT_EVENT_OWNER');
        assert.deepEqual(err.details, { eventId: s.event.id }, `${method} ${template}`);
        const forbidden = await call(method, url, { token: s.admin, body });
        assertError(forbidden.res, forbidden.body, 403, 'FORBIDDEN');
      }
      const same = await expectContract('GET', path, 200, { token: s.orgA.token }, ev());
      assert.deepEqual(same, s.event);
    });

    test('PUT /events/{id} por el dueño -> 200; inválido -> 400; recinto inexistente -> 404', async () => {
      const path = `/events/${s.event.id}`;
      const token = s.orgA.token;
      const body = { ...input(), title: `Noche de Rock Nacional ${RUN}`, startsAt: inDays(20) };
      const updated = await expectContract('PUT', path, 200, { token, body }, ev());
      assert.equal(updated.title, body.title);
      assert.equal(updated.startsAt, body.startsAt);
      assert.equal(updated.status, 'DRAFT');
      s.event = updated;
      await expectContract('PUT', path, 400, { token, body: { ...body, title: '' } }, ev());
      const noVenue = await expectContract(
        'PUT',
        path,
        404,
        {
          token,
          body: { ...body, venueId: 999999999 },
        },
        ev(),
      );
      assert.equal(noVenue.code, 'VENUE_NOT_FOUND');
    });

    test('PATCH status: publicar sin zonas -> 409 EVENT_HAS_NO_ZONES; con zonas -> 200; Inventory caído -> 503', async () => {
      const path = `/events/${s.event.id}/status`;
      const token = s.orgA.token;
      const publish = { token, body: { status: 'PUBLISHED' } };
      fakes.tokens.length = 0;
      const noZones = await expectContract('PATCH', path, 409, publish, ev('/status'));
      assert.equal(noZones.code, 'EVENT_HAS_NO_ZONES');
      assert.deepEqual(fakes.tokens, [INTERNAL_TOKEN], 'Catalog manda X-Internal-Token');

      fakes.inventoryUp = false;
      try {
        const down = await expectContract('PATCH', path, 503, publish, ev('/status'));
        assert.equal(down.code, 'SERVICE_UNAVAILABLE');
      } finally {
        fakes.inventoryUp = true;
      }

      fakes.zonesByEvent.set(s.event.id, 2);
      fakes.zonesByEvent.set(s.event2.id, 1);
      fakes.zonesByEvent.set(s.eventB.id, 1);
      const published = await expectContract('PATCH', path, 200, publish, ev('/status'));
      assert.equal(published.status, 'PUBLISHED');
      s.event = published;
      s.event2 = await expectContract(
        'PATCH',
        `/events/${s.event2.id}/status`,
        200,
        publish,
        ev('/status'),
      );
      await expectContract(
        'PATCH',
        `/events/${s.eventB.id}/status`,
        200,
        {
          token: s.orgB.token,
          body: { status: 'PUBLISHED' },
        },
        ev('/status'),
      );

      const again = await expectContract('PATCH', path, 409, publish, ev('/status'));
      assert.deepEqual(again, {
        code: 'INVALID_EVENT_STATE',
        message: 'No se puede cambiar el evento a ese estado',
        details: { from: 'PUBLISHED', to: 'PUBLISHED' },
      });
      const invalid = await expectContract(
        'PATCH',
        path,
        400,
        { token, body: { status: 'DRAFT' } },
        ev('/status'),
      );
      assert.deepEqual(invalid.details.fields, [{ field: 'status', issue: 'invalid_value' }]);
    });

    test('GET /events público: solo PUBLISHED futuros, filtros y orden por startsAt', async () => {
      const all = await expectContract('GET', `/events?q=${RUN}`, 200, {}, '/events');
      assert.deepEqual(
        all.items.map((e) => e.id),
        [s.event.id, s.eventB.id, s.event2.id],
      );
      assert.deepEqual(all.items[0], s.event);
      const filters = [
        [`category=FESTIVAL`, [s.event2.id]],
        [`city=ZAPOPAN`, [s.event.id, s.eventB.id, s.event2.id]],
        [`city=Monterrey`, []],
        [`venueId=${s.venue.id}&category=THEATER`, [s.eventB.id]],
        [`from=${encodeURIComponent(inDays(45))}`, [s.event2.id]],
        [`to=${encodeURIComponent(inDays(25))}`, [s.event.id]],
        [`pageSize=1&page=2`, [s.eventB.id]],
      ];
      for (const [query, ids] of filters) {
        const page = await expectContract('GET', `/events?q=${RUN}&${query}`, 200, {}, '/events');
        assert.deepEqual(
          page.items.map((e) => e.id),
          ids,
          query,
        );
      }
      const bad = await expectContract(
        'GET',
        '/events?category=OPERA&from=ayer',
        400,
        {},
        '/events',
      );
      assert.deepEqual(bad.details.fields, [
        { field: 'category', issue: 'invalid_value' },
        { field: 'from', issue: 'invalid_format' },
      ]);
      const draft = await expectContract('POST', '/events', 201, {
        token: s.orgA.token,
        body: { ...input(), title: `Borrador ${RUN}` },
      });
      s.draft = draft;
      const search = await expectContract('GET', `/events?q=Borrador ${RUN}`, 200, {}, '/events');
      assert.equal(search.totalItems, 0);
    });

    test('GET /organizer/events: solo los del organizador, filtro por status', async () => {
      const mine = await expectContract('GET', '/organizer/events', 200, { token: s.orgA.token });
      assert.deepEqual(
        mine.items.map((e) => e.id).sort(),
        [s.event.id, s.event2.id, s.draft.id].sort(),
      );
      const drafts = await expectContract(
        'GET',
        '/organizer/events?status=DRAFT',
        200,
        {
          token: s.orgA.token,
        },
        '/organizer/events',
      );
      assert.deepEqual(
        drafts.items.map((e) => e.id),
        [s.draft.id],
      );
      const other = await expectContract('GET', '/organizer/events', 200, { token: s.orgB.token });
      assert.deepEqual(
        other.items.map((e) => e.id),
        [s.eventB.id],
      );
      await expectContract('GET', '/organizer/events', 403, { token: s.admin });
      const bad = await expectContract(
        'GET',
        '/organizer/events?status=BORRADOR',
        400,
        { token: s.orgA.token },
        '/organizer/events',
      );
      assert.deepEqual(bad.details.fields, [{ field: 'status', issue: 'invalid_value' }]);
    });

    test('DELETE /events/{id}: PUBLISHED -> 409; Inventory caído -> 503 sin borrar; DRAFT -> 204 con sus zonas', async () => {
      const token = s.orgA.token;
      const conflict = await expectContract(
        'DELETE',
        `/events/${s.event2.id}`,
        409,
        { token },
        ev(),
      );
      assert.deepEqual(conflict.details, { status: 'PUBLISHED' });
      fakes.zonesByEvent.set(s.draft.id, 2);
      fakes.inventoryUp = false;
      try {
        const down = await expectContract('DELETE', `/events/${s.draft.id}`, 503, { token }, ev());
        assert.equal(down.code, 'SERVICE_UNAVAILABLE');
      } finally {
        fakes.inventoryUp = true;
      }
      await expectContract('GET', `/events/${s.draft.id}`, 200, { token }, ev());
      assert.equal(fakes.deletedZones.includes(s.draft.id), false);

      await expectContract('DELETE', `/events/${s.draft.id}`, 204, { token }, ev());
      assert.equal(fakes.deletedZones.includes(s.draft.id), true);
      assert.equal(fakes.zonesByEvent.has(s.draft.id), false);
      await expectContract('DELETE', `/events/${s.draft.id}`, 404, { token }, ev());
      assert.equal(fakes.deletedZones.filter((id) => id === s.draft.id).length, 1);
    });

    test('recinto con eventos -> DELETE 409 VENUE_IN_USE', async () => {
      const err = await expectContract(
        'DELETE',
        `/venues/${s.venue.id}`,
        409,
        {
          token: s.admin,
        },
        '/venues/{venueId}',
      );
      assert.equal(err.code, 'VENUE_IN_USE');
    });

    test('póster: sin póster -> 404 POSTER_NOT_FOUND; archivo faltante 400, no imagen 415, > 5 MB 413', async () => {
      const got = await expectContract(
        'GET',
        `/events/${s.event.id}/poster`,
        404,
        {},
        ev('/poster'),
      );
      assert.equal(got.code, 'POSTER_NOT_FOUND');
      const path = `/events/${s.event.id}/poster`;
      const token = s.orgA.token;
      const cases = [
        [form({ otro: 'x' }), 400, 'VALIDATION_ERROR'],
        [JSON.stringify({ file: 'x' }), 400, 'VALIDATION_ERROR'],
        [form({ file: new Blob(['hola'], { type: 'image/png' }) }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
        [
          form({ file: new Blob([PNG, Buffer.alloc(5 * 1024 * 1024)], { type: 'image/png' }) }),
          413,
          'FILE_TOO_LARGE',
        ],
      ];
      for (const [body, status, code] of cases) {
        const { res, body: err } = await upload(path, token, body);
        assertContract(res, err, 'PUT', `/api/v1${ev('/poster')}`, status);
        assert.equal(err.code, code);
      }
      const { body: missing } = await upload(path, token, form({ otro: 'x' }));
      assert.deepEqual(missing.details.fields, [{ field: 'file', issue: 'required' }]);
    });

    test('póster: el dueño sube PNG y lo reemplaza por JPG; se descarga por el gateway desde MinIO', async () => {
      const path = `/events/${s.event.id}/poster`;
      const token = s.orgA.token;
      const first = await upload(
        path,
        token,
        form({ file: new Blob([PNG], { type: 'image/png' }) }),
      );
      assertContract(first.res, first.body, 'PUT', `/api/v1${ev('/poster')}`, 200);
      assert.ok(first.body.posterUrl.endsWith(`/events/${s.event.id}/poster`));
      let download = await fetch(`${GATEWAY}${path}`);
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG);

      const second = await upload(
        path,
        token,
        form({ file: new Blob([JPEG], { type: 'image/jpeg' }) }),
      );
      assertContract(second.res, second.body, 'PUT', `/api/v1${ev('/poster')}`, 200);
      download = await fetch(`${GATEWAY}${path}`);
      assert.equal(download.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), JPEG);

      const listed = await expectContract('GET', `/events?q=${RUN}`, 200, {}, '/events');
      assert.equal(listed.items.find((e) => e.id === s.event.id).posterUrl, second.body.posterUrl);
      s.event = second.body;
    });

    test('póster de un DRAFT: el dueño lo ve, el público recibe 404', async () => {
      const draft = await expectContract('POST', '/events', 201, {
        token: s.orgA.token,
        body: { ...input(), title: `Con póster ${RUN}` },
      });
      const path = `/events/${draft.id}/poster`;
      const up = await upload(
        path,
        s.orgA.token,
        form({ file: new Blob([PNG], { type: 'image/png' }) }),
      );
      assert.equal(up.res.status, 200);
      const anon = await expectContract('GET', path, 404, {}, ev('/poster'));
      assert.equal(anon.code, 'EVENT_NOT_FOUND');
      const owner = await fetch(`${GATEWAY}${path}`, {
        headers: { authorization: `Bearer ${s.orgA.token}` },
      });
      assert.equal(owner.status, 200);
      await expectContract('DELETE', `/events/${draft.id}`, 204, { token: s.orgA.token }, ev());
    });
  });

  describe('Personal del evento', () => {
    const staffPath = (userId, eventId = s.event.id) => `/events/${eventId}/staff/${userId}`;

    test('PUT asigna personal propio -> 200 idempotente; personal ajeno o no STAFF -> 403 NOT_OWN_STAFF', async () => {
      const token = s.orgA.token;
      const first = await expectContract(
        'PUT',
        staffPath(s.staffA.id),
        200,
        { token },
        ev('/staff/{userId}'),
      );
      assert.equal(first.eventId, s.event.id);
      assert.equal(first.userId, s.staffA.id);
      const second = await expectContract(
        'PUT',
        staffPath(s.staffA.id),
        200,
        { token },
        ev('/staff/{userId}'),
      );
      assert.deepEqual(second, first);
      await expectContract(
        'PUT',
        staffPath(s.staffA.id, s.event2.id),
        200,
        { token },
        ev('/staff/{userId}'),
      );
      for (const userId of [s.staffB.id, s.buyerId, s.orgA.id, 999999999]) {
        const err = await expectContract(
          'PUT',
          staffPath(userId),
          403,
          { token },
          ev('/staff/{userId}'),
        );
        assert.equal(err.code, 'NOT_OWN_STAFF', String(userId));
      }
      await expectContract(
        'PUT',
        staffPath(s.staffA.id, 999999999),
        404,
        { token },
        ev('/staff/{userId}'),
      );
    });

    test('GET /events/{id}/staff (dueño) y GET /staff/events (STAFF)', async () => {
      const list = await expectContract(
        'GET',
        `/events/${s.event.id}/staff`,
        200,
        {
          token: s.orgA.token,
        },
        ev('/staff'),
      );
      assert.deepEqual(
        list.map((a) => a.userId),
        [s.staffA.id],
      );
      const mine = await expectContract('GET', '/staff/events', 200, { token: s.staffA.token });
      assert.deepEqual(
        mine.map((e) => e.id),
        [s.event.id, s.event2.id],
      );
      const none = await expectContract('GET', '/staff/events', 200, { token: s.staffB.token });
      assert.deepEqual(none, []);
      await expectContract('GET', '/staff/events', 403, { token: s.orgA.token });
    });

    test('/internal/events/{id}/staff/{userId}: 200 si está asignado; 404 NOT_ASSIGNED si no', async () => {
      const ok = await call('GET', staffPath(s.staffA.id).replace('/events', '/internal/events'), {
        base: CATALOG,
        headers: internal,
      });
      assert.equal(ok.res.status, 200);
      assertSchema(ASSIGNMENT_SCHEMA, ok.body, 'internalCheckStaffAssignment');
      for (const path of [staffPath(s.staffB.id), staffPath(s.staffA.id, 999999999)]) {
        const no = await call('GET', path.replace('/events', '/internal/events'), {
          base: CATALOG,
          headers: internal,
        });
        assertError(no.res, no.body, 404, 'NOT_ASSIGNED');
      }
    });

    test('DELETE quita la asignación -> 204; otra vez -> 404 NOT_FOUND', async () => {
      const token = s.orgA.token;
      await expectContract(
        'DELETE',
        staffPath(s.staffA.id, s.event2.id),
        204,
        { token },
        ev('/staff/{userId}'),
      );
      const again = await expectContract(
        'DELETE',
        staffPath(s.staffA.id, s.event2.id),
        404,
        { token },
        ev('/staff/{userId}'),
      );
      assert.equal(again.code, 'NOT_FOUND');
      const mine = await expectContract('GET', '/staff/events', 200, { token: s.staffA.token });
      assert.deepEqual(
        mine.map((e) => e.id),
        [s.event.id],
      );
    });
  });

  describe('Cancelación', () => {
    test('PATCH CANCELLED -> 200; luego 410 para el público, 409 al editar, republicar o subir póster', async () => {
      const token = s.orgA.token;
      const path = `/events/${s.event.id}`;
      const cancelled = await expectContract(
        'PATCH',
        `${path}/status`,
        200,
        {
          token,
          body: { status: 'CANCELLED' },
        },
        ev('/status'),
      );
      assert.equal(cancelled.status, 'CANCELLED');
      for (const auth of [undefined, s.buyer, s.orgB.token]) {
        const err = await expectContract('GET', path, 410, { token: auth }, ev());
        assert.equal(err.code, 'EVENT_CANCELLED');
      }
      const poster = await expectContract('GET', `${path}/poster`, 410, {}, ev('/poster'));
      assert.equal(poster.code, 'EVENT_CANCELLED');
      const blocked = await upload(
        `${path}/poster`,
        token,
        form({ file: new Blob([PNG], { type: 'image/png' }) }),
      );
      assertContract(blocked.res, blocked.body, 'PUT', `/api/v1${ev('/poster')}`, 409);
      assert.deepEqual(blocked.body.details, { status: 'CANCELLED' });
      const ownerPoster = await fetch(`${GATEWAY}${path}/poster`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(ownerPoster.status, 200);
      assert.deepEqual(Buffer.from(await ownerPoster.arrayBuffer()), JPEG);
      await expectContract('GET', path, 200, { token }, ev());
      await expectContract('GET', path, 200, { token: s.admin }, ev());
      const edit = await expectContract(
        'PUT',
        path,
        409,
        {
          token,
          body: {
            venueId: s.venue.id,
            title: 'x',
            description: 'y',
            category: 'OTHER',
            startsAt: inDays(5),
          },
        },
        ev(),
      );
      assert.deepEqual(edit.details, { status: 'CANCELLED' });
      const republish = await expectContract(
        'PATCH',
        `${path}/status`,
        409,
        {
          token,
          body: { status: 'PUBLISHED' },
        },
        ev('/status'),
      );
      assert.deepEqual(republish.details, { from: 'CANCELLED', to: 'PUBLISHED' });
      const list = await expectContract('GET', `/events?q=${RUN}`, 200, {}, '/events');
      assert.equal(
        list.items.some((e) => e.id === s.event.id),
        false,
      );
      assert.deepEqual(
        await expectContract('GET', '/staff/events', 200, { token: s.staffA.token }),
        [],
      );
    });
  });

  describe('Resumen global CU-16', () => {
    test('GET /admin/summary: ADMIN -> 200 con usuarios de Identity y ventas de Purchase', async () => {
      const summary = await expectContract('GET', '/admin/summary', 200, { token: s.admin });
      const { byStatus } = summary.events;
      assert.equal(summary.events.total, byStatus.DRAFT + byStatus.PUBLISHED + byStatus.CANCELLED);
      assert.ok(byStatus.PUBLISHED >= 2 && byStatus.CANCELLED >= 1);
      assert.ok(summary.events.upcoming >= 2 && summary.events.upcoming <= byStatus.PUBLISHED);
      assert.ok(summary.venues.total >= 1);
      assert.ok(summary.users.byRole.ORGANIZER >= 2 && summary.users.byRole.STAFF >= 2);
      assert.deepEqual(summary.sales, fakes.sales);
      assert.deepEqual(summary.unavailableSections, []);
    });

    test('PurchaseService caído -> sales null y "sales" en unavailableSections', async () => {
      fakes.salesUp = false;
      try {
        const summary = await expectContract('GET', '/admin/summary', 200, { token: s.admin });
        assert.equal(summary.sales, null);
        assert.notEqual(summary.users, null);
        assert.deepEqual(summary.unavailableSections, ['sales']);
      } finally {
        fakes.salesUp = true;
      }
    });

    test('GET /admin/summary: otros roles -> 403; sin token -> 401', async () => {
      for (const token of [s.orgA.token, s.buyer, s.staffA.token]) {
        await expectContract('GET', '/admin/summary', 403, { token });
      }
      await expectContract('GET', '/admin/summary', 401);
    });
  });

  describe('Rutas internas', () => {
    test('/internal/events/{id}: cualquier estado con X-Internal-Token; sin él -> 401', async () => {
      const ok = await call('GET', `/internal/events/${s.event.id}`, {
        base: CATALOG,
        headers: internal,
      });
      assert.equal(ok.res.status, 200);
      assertSchema(EVENT_SCHEMA, ok.body, 'internalGetEvent');
      assert.equal(ok.body.status, 'CANCELLED');
      const missing = await call('GET', '/internal/events/999999999', {
        base: CATALOG,
        headers: internal,
      });
      assertError(missing.res, missing.body, 404, 'EVENT_NOT_FOUND');
      for (const headers of [{}, { 'x-internal-token': 'incorrecto' }]) {
        const denied = await call('GET', `/internal/events/${s.event.id}`, {
          base: CATALOG,
          headers,
        });
        assertError(denied.res, denied.body, 401, 'UNAUTHORIZED');
      }
    });

    test('/internal/events?ids=: en el orden pedido, omite los que no existen; ids inválidos -> 400', async () => {
      const ids = [s.eventB.id, 999999999, s.event.id];
      const ok = await call('GET', `/internal/events?ids=${ids.join(',')}`, {
        base: CATALOG,
        headers: internal,
      });
      assert.equal(ok.res.status, 200);
      assertSchema({ type: 'array', items: EVENT_SCHEMA }, ok.body, 'internalGetEventsByIds');
      assert.deepEqual(
        ok.body.map((e) => e.id),
        [s.eventB.id, s.event.id],
      );
      const tooMany = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
      for (const query of ['', '?ids=', '?ids=1,x', `?ids=${tooMany}`]) {
        const bad = await call('GET', `/internal/events${query}`, {
          base: CATALOG,
          headers: internal,
        });
        assertError(bad.res, bad.body, 400, 'VALIDATION_ERROR');
      }
    });

    test('/internal/** desconocida -> 404 aunque falte el token (Catalog e Identity); el gateway no las enruta', async () => {
      for (const base of [CATALOG, IDENTITY]) {
        const unknown = await call('GET', '/internal/no-existe', { base });
        assertError(unknown.res, unknown.body, 404, 'NOT_FOUND');
      }
      const viaGateway = await call('GET', `/internal/events/${s.event.id}`, { headers: internal });
      assertError(viaGateway.res, viaGateway.body, 404, 'NOT_FOUND');
    });
  });
});
