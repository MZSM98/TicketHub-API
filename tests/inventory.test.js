import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { assertContract, assertSchema, responseSchema } from './contract.js';
import { startFakes } from './fakes.js';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  call,
  createOrganizer,
  email,
  expectContract,
  INTERNAL_TOKEN,
  INVENTORY,
  INVENTORY_LAZY,
  INVENTORY_NOCATALOG,
  INVENTORY_SWEEP,
  login,
  RUN,
} from './helpers.js';

const BUYERS = 50;
const internal = { 'x-internal-token': INTERNAL_TOKEN };
const RESERVATION_SCHEMA = responseSchema('GET', '/api/v1/reservations/{reservationId}', 200);
const INTERNAL_RESERVATION_SCHEMA = {
  allOf: [
    RESERVATION_SCHEMA,
    {
      type: 'object',
      required: ['purchaseId'],
      properties: { purchaseId: { type: 'integer', minimum: 1, nullable: true } },
    },
  ],
};
const ZONES_SCHEMA = responseSchema('GET', '/api/v1/events/{eventId}/zones', 200);
const ERROR_SCHEMA = responseSchema('POST', '/api/v1/reservations', 400);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inDays = (days) =>
  new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');

async function internalCall(method, path, { body, base = INVENTORY, headers = internal } = {}) {
  return call(method, path, { body, base, headers });
}

async function expectInternal(method, path, status, schema, options) {
  const { res, body } = await internalCall(method, path, options);
  assert.equal(res.status, status, JSON.stringify(body));
  if (schema) assertSchema(schema, body, `${method} ${path} ${status}`);
  return body;
}

const zoneCounters = async (zoneId) =>
  (await expectInternal('GET', `/internal/zones?ids=${zoneId}`, 200, ZONES_SCHEMA))[0];

function tally(results) {
  const counts = {};
  for (const { res, body } of results) {
    const key = `${res.status} ${body?.code ?? (res.status === 201 ? body.status : '')}`.trim();
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function reserveAll(tokens, body) {
  return Promise.all(
    tokens.map((token) =>
      call('POST', '/reservations', { token, body }).then((result) => {
        assertContract(result.res, result.body, 'POST', '/api/v1/reservations', result.res.status);
        return { ...result, token };
      }),
    ),
  );
}

async function cancelAll(results) {
  for (const { res, body, token } of results) {
    if (res.status !== 201) continue;
    await expectContract(
      'POST',
      `/reservations/${body.id}/cancel`,
      200,
      { token },
      '/reservations/{reservationId}/cancel',
    );
  }
}

describe('InventoryService (inventory.yaml)', () => {
  const s = {};
  const zonePath = '/events/{eventId}/zones';

  async function newEvent(token, title) {
    return expectContract('POST', '/events', 201, {
      token,
      body: {
        venueId: s.venue.id,
        title: `${title} ${RUN}`,
        description: 'Evento de prueba de inventario.',
        category: 'CONCERT',
        startsAt: inDays(20),
      },
    });
  }

  const addZone = (eventId, body, token = s.orgA.token) =>
    expectContract('POST', `/events/${eventId}/zones`, 201, { token, body }, zonePath);

  const setStatus = (eventId, status, token = s.orgA.token) =>
    expectContract(
      'PATCH',
      `/events/${eventId}/status`,
      200,
      { token, body: { status } },
      '/events/{eventId}/status',
    );

  let fakeServer;

  before(async () => {
    fakeServer = await startFakes(Number(process.env.FAKES_PORT ?? 4100), INTERNAL_TOKEN);
    s.admin = (await login(ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    s.orgA = await createOrganizer(s.admin, 'inv-org-a');
    s.orgB = await createOrganizer(s.admin, 'inv-org-b');
    s.venue = await expectContract('POST', '/venues', 201, {
      token: s.orgA.token,
      body: { name: `Arena ${RUN}`, address: 'Calle 1', city: 'Guadalajara' },
    });
    const accounts = Array.from({ length: BUYERS }, (_, i) => ({
      name: `Comprador ${i}`,
      email: email(`inv-buyer-${i}`),
      password: 'S3gura!2026',
    }));
    s.buyers = [];
    for (const account of accounts) {
      await expectContract('POST', '/auth/register', 201, { body: account });
      s.buyers.push((await login(account.email, account.password)).accessToken);
    }
    s.event = await newEvent(s.orgA.token, 'Inventario');
    s.other = await newEvent(s.orgA.token, 'Otro');
  });

  after(() => fakeServer?.close());

  describe('Zonas y asientos', () => {
    test('POST zonas: dueño -> 201; otro organizador -> 403 NOT_EVENT_OWNER; BUYER -> 403; inválido -> 400', async () => {
      s.numbered = await addZone(s.event.id, {
        name: 'Platea',
        type: 'NUMBERED',
        price: '500.00',
        capacity: 6,
      });
      assert.deepEqual(s.numbered, {
        id: s.numbered.id,
        eventId: s.event.id,
        name: 'Platea',
        type: 'NUMBERED',
        price: '500.00',
        currency: 'MXN',
        capacity: 6,
        reservedCount: 0,
        soldCount: 0,
      });
      s.general = await addZone(s.event.id, {
        name: 'General',
        type: 'GENERAL',
        price: '250.50',
        capacity: 20,
      });
      s.pista = await addZone(s.event.id, {
        name: 'Pista',
        type: 'GENERAL',
        price: '100.00',
        capacity: 20,
      });
      s.otherSeats = await addZone(s.other.id, {
        name: 'Palco',
        type: 'NUMBERED',
        price: '900.00',
        capacity: 2,
      });
      const body = { name: 'X', type: 'GENERAL', price: '1.00', capacity: 1 };
      const notOwner = await expectContract(
        'POST',
        `/events/${s.event.id}/zones`,
        403,
        { token: s.orgB.token, body },
        zonePath,
      );
      assert.equal(notOwner.code, 'NOT_EVENT_OWNER');
      await expectContract(
        'POST',
        `/events/${s.event.id}/zones`,
        403,
        { token: s.buyers[0], body },
        zonePath,
      );
      await expectContract('POST', `/events/${s.event.id}/zones`, 401, { body }, zonePath);
      const invalid = await expectContract(
        'POST',
        `/events/${s.event.id}/zones`,
        400,
        { token: s.orgA.token, body: { name: '', type: 'VIP', price: '10', capacity: 0 } },
        zonePath,
      );
      assert.deepEqual(invalid.details.fields.map((f) => f.field).sort(), [
        'capacity',
        'name',
        'price',
        'type',
      ]);
      const missing = await expectContract(
        'POST',
        '/events/999999999/zones',
        404,
        { token: s.orgA.token, body },
        zonePath,
      );
      assert.equal(missing.code, 'EVENT_NOT_FOUND');
    });

    test('GET zonas: dueño y ADMIN -> 200; PUT y DELETE de zona', async () => {
      const own = await expectContract(
        'GET',
        `/events/${s.event.id}/zones`,
        200,
        { token: s.orgA.token },
        zonePath,
      );
      assert.deepEqual(
        own.map((z) => z.id),
        [s.numbered.id, s.general.id, s.pista.id],
      );
      await expectContract('GET', `/events/${s.event.id}/zones`, 200, { token: s.admin }, zonePath);
      await expectContract(
        'GET',
        `/events/${s.event.id}/zones`,
        403,
        { token: s.orgB.token },
        zonePath,
      );
      const path = `/zones/${s.pista.id}`;
      const updated = await expectContract(
        'PUT',
        path,
        200,
        {
          token: s.orgA.token,
          body: { name: 'Pista VIP', type: 'GENERAL', price: '150.00', capacity: 30 },
        },
        '/zones/{zoneId}',
      );
      assert.equal(updated.name, 'Pista VIP');
      assert.equal(updated.capacity, 30);
      const typeChange = await expectContract(
        'PUT',
        path,
        409,
        {
          token: s.orgA.token,
          body: { name: 'Pista', type: 'NUMBERED', price: '150.00', capacity: 30 },
        },
        '/zones/{zoneId}',
      );
      assert.deepEqual(
        [typeChange.code, typeChange.details],
        ['ZONE_TYPE_CHANGE', { type: 'GENERAL' }],
      );
      const temp = await addZone(s.event.id, {
        name: 'Temporal',
        type: 'GENERAL',
        price: '1.00',
        capacity: 5,
      });
      await expectContract(
        'DELETE',
        `/zones/${temp.id}`,
        403,
        { token: s.orgB.token },
        '/zones/{zoneId}',
      );
      await expectContract(
        'DELETE',
        `/zones/${temp.id}`,
        204,
        { token: s.orgA.token },
        '/zones/{zoneId}',
      );
      const gone = await expectContract(
        'DELETE',
        `/zones/${temp.id}`,
        404,
        { token: s.orgA.token },
        '/zones/{zoneId}',
      );
      assert.equal(gone.code, 'ZONE_NOT_FOUND');
    });

    test('POST asientos: general -> 409 ZONE_NOT_NUMBERED; total distinto -> 400 SEAT_COUNT_MISMATCH; válido -> 201', async () => {
      const seatsPath = '/zones/{zoneId}/seats';
      const general = await expectContract(
        'POST',
        `/zones/${s.general.id}/seats`,
        409,
        { token: s.orgA.token, body: { rows: [{ rowLabel: 'A', seatCount: 20 }] } },
        seatsPath,
      );
      assert.equal(general.code, 'ZONE_NOT_NUMBERED');
      const mismatch = await expectContract(
        'POST',
        `/zones/${s.numbered.id}/seats`,
        400,
        { token: s.orgA.token, body: { rows: [{ rowLabel: 'A', seatCount: 5 }] } },
        seatsPath,
      );
      assert.equal(mismatch.code, 'SEAT_COUNT_MISMATCH');
      assert.deepEqual(mismatch.details, { capacity: 6, seats: 5 });
      const duplicate = await expectContract(
        'POST',
        `/zones/${s.numbered.id}/seats`,
        400,
        {
          token: s.orgA.token,
          body: {
            rows: [
              { rowLabel: 'A', seatCount: 3 },
              { rowLabel: 'A', seatCount: 3 },
            ],
          },
        },
        seatsPath,
      );
      assert.equal(duplicate.code, 'VALIDATION_ERROR');
      const layout = {
        rows: [
          { rowLabel: 'A', seatCount: 3 },
          { rowLabel: 'B', seatCount: 3 },
        ],
      };
      await expectContract(
        'POST',
        `/zones/${s.numbered.id}/seats`,
        403,
        { token: s.orgB.token, body: layout },
        seatsPath,
      );
      const map = await expectContract(
        'POST',
        `/zones/${s.numbered.id}/seats`,
        201,
        { token: s.orgA.token, body: layout },
        seatsPath,
      );
      assert.deepEqual(
        map.rows.map((r) => [r.rowLabel, r.seats.map((seat) => seat.seatNumber)]),
        [
          ['A', [1, 2, 3]],
          ['B', [1, 2, 3]],
        ],
      );
      s.seats = Object.fromEntries(
        map.rows.flatMap((r) =>
          r.seats.map((seat) => [`${r.rowLabel}${seat.seatNumber}`, seat.id]),
        ),
      );
      const again = await expectContract(
        'POST',
        `/zones/${s.numbered.id}/seats`,
        201,
        { token: s.orgA.token, body: layout },
        seatsPath,
      );
      assert.notEqual(again.rows[0].seats[0].id, s.seats.A1, 'regenera el plano');
      s.seats = Object.fromEntries(
        again.rows.flatMap((r) =>
          r.seats.map((seat) => [`${r.rowLabel}${seat.seatNumber}`, seat.id]),
        ),
      );
      const other = await expectContract(
        'POST',
        `/zones/${s.otherSeats.id}/seats`,
        201,
        { token: s.orgA.token, body: { rows: [{ rowLabel: 'P', seatCount: 2 }] } },
        seatsPath,
      );
      s.foreignSeat = other.rows[0].seats[0].id;
      const hidden = await expectContract(
        'GET',
        `/zones/${s.numbered.id}/seats`,
        404,
        {},
        seatsPath,
      );
      assert.equal(hidden.code, 'ZONE_NOT_FOUND', 'zona de un evento DRAFT');
    });

    test('disponibilidad: borrador -> 404; publicado -> 200 público', async () => {
      const path = `/events/${s.event.id}/availability`;
      const tpl = '/events/{eventId}/availability';
      const draft = await expectContract('GET', path, 404, {}, tpl);
      assert.equal(draft.code, 'EVENT_NOT_FOUND');
      await setStatus(s.event.id, 'PUBLISHED');
      await setStatus(s.other.id, 'PUBLISHED');
      const availability = await expectContract('GET', path, 200, {}, tpl);
      assert.equal(availability.eventId, s.event.id);
      assert.equal(availability.soldOut, false);
      assert.deepEqual(
        availability.zones.map((z) => [z.id, z.available, z.soldOut]),
        [
          [s.numbered.id, 6, false],
          [s.general.id, 20, false],
          [s.pista.id, 30, false],
        ],
      );
      const seatsPath = '/zones/{zoneId}/seats';
      const publicMap = await expectContract(
        'GET',
        `/zones/${s.numbered.id}/seats`,
        200,
        {},
        seatsPath,
      );
      assert.equal(publicMap.price, '500.00');
      assert.ok(publicMap.rows.every((r) => r.seats.every((seat) => seat.status === 'AVAILABLE')));
      const notNumbered = await expectContract(
        'GET',
        `/zones/${s.general.id}/seats`,
        409,
        {},
        seatsPath,
      );
      assert.equal(notNumbered.code, 'ZONE_NOT_NUMBERED');
    });
  });

  describe('Reservas', () => {
    const tpl = '/reservations/{reservationId}';

    test('POST /reservations inválido -> 400, 401, 403, 404, TOO_MANY_TICKETS', async () => {
      const token = s.buyers[0];
      await expectContract('POST', '/reservations', 401, {
        body: { eventId: s.event.id, items: [{ seatId: s.seats.A1 }] },
      });
      const organizer = await expectContract('POST', '/reservations', 403, {
        token: s.orgA.token,
        body: { eventId: s.event.id, items: [{ seatId: s.seats.A1 }] },
      });
      assert.equal(organizer.code, 'FORBIDDEN');
      const empty = await expectContract('POST', '/reservations', 400, {
        token,
        body: { eventId: s.event.id, items: [] },
      });
      assert.deepEqual(empty.details.fields, [{ field: 'items', issue: 'too_short' }]);
      const mixed = await expectContract('POST', '/reservations', 400, {
        token,
        body: { items: [{ seatId: s.seats.A1, zoneId: s.general.id, quantity: 1 }] },
      });
      assert.deepEqual(
        mixed.details.fields.map((f) => f.field),
        ['eventId', 'items[0]'],
      );
      const repeated = await expectContract('POST', '/reservations', 400, {
        token,
        body: { eventId: s.event.id, items: [{ seatId: s.seats.A1 }, { seatId: s.seats.A1 }] },
      });
      assert.deepEqual(repeated.details.fields, [{ field: 'items[1]', issue: 'duplicate' }]);
      const tooMany = await expectContract('POST', '/reservations', 400, {
        token,
        body: {
          eventId: s.event.id,
          items: [{ seatId: s.seats.A1 }, { zoneId: s.general.id, quantity: 10 }],
        },
      });
      assert.equal(tooMany.code, 'TOO_MANY_TICKETS');
      assert.deepEqual(tooMany.details, { max: 10 });
      const foreign = await expectContract('POST', '/reservations', 400, {
        token,
        body: { eventId: s.event.id, items: [{ seatId: s.foreignSeat }] },
      });
      assert.deepEqual(foreign.details.fields, [
        { field: 'items[0].seatId', issue: 'invalid_value' },
      ]);
      const seatAsZone = await expectContract('POST', '/reservations', 400, {
        token,
        body: { eventId: s.event.id, items: [{ zoneId: s.numbered.id, quantity: 1 }] },
      });
      assert.deepEqual(seatAsZone.details.fields, [
        { field: 'items[0].zoneId', issue: 'invalid_value' },
      ]);
      const missing = await expectContract('POST', '/reservations', 404, {
        token,
        body: { eventId: 999999999, items: [{ seatId: s.seats.A1 }] },
      });
      assert.equal(missing.code, 'EVENT_NOT_FOUND');
      const noActive = await expectContract('GET', '/reservations/active', 404, { token });
      assert.equal(noActive.code, 'NO_ACTIVE_RESERVATION');
    });

    test(`concurrencia: ${BUYERS} compradores por el gateway por el mismo asiento -> exactamente 1 gana`, async () => {
      const seatId = s.seats.A1;
      const results = await reserveAll(s.buyers, { eventId: s.event.id, items: [{ seatId }] });
      const counts = tally(results);
      console.log(`[concurrencia asiento ${seatId}] ${JSON.stringify(counts)}`);
      assert.deepEqual(counts, { '201 ACTIVE': 1, '409 SEAT_UNAVAILABLE': BUYERS - 1 });
      for (const { res, body } of results) {
        if (res.status === 409) assert.deepEqual(body.details, { unavailableSeatIds: [seatId] });
      }
      const winner = results.find((r) => r.res.status === 201);
      assert.equal(winner.body.items.length, 1);
      assert.equal(winner.body.items[0].seatId, seatId);
      assert.equal(winner.body.total, '500.00');
      const map = await expectContract(
        'GET',
        `/zones/${s.numbered.id}/seats`,
        200,
        {},
        '/zones/{zoneId}/seats',
      );
      const reserved = map.rows
        .flatMap((r) => r.seats)
        .filter((seat) => seat.status !== 'AVAILABLE');
      assert.deepEqual(reserved, [{ id: seatId, seatNumber: 1, status: 'RESERVED' }]);
      assert.equal((await zoneCounters(s.numbered.id)).reservedCount, 1);
      console.log(
        `[concurrencia asiento ${seatId}] ganadora reserva ${winner.body.id}; asientos no disponibles: ${JSON.stringify(reserved)}`,
      );
      s.seatWinner = winner;
    });

    test(`concurrencia: zona general con capacidad 20 y ${BUYERS} compradores -> nunca se sobrevende`, async () => {
      await cancelAll([s.seatWinner]);
      const single = await reserveAll(s.buyers, {
        eventId: s.event.id,
        items: [{ zoneId: s.general.id, quantity: 1 }],
      });
      const counts = tally(single);
      const zone = await zoneCounters(s.general.id);
      const availability = await expectContract(
        'GET',
        `/events/${s.event.id}/availability`,
        200,
        {},
        '/events/{eventId}/availability',
      );
      await cancelAll(single);
      console.log(
        `[concurrencia general x1] ${JSON.stringify(counts)} reservedCount=${zone.reservedCount}/${zone.capacity}`,
      );
      assert.deepEqual(counts, { '201 ACTIVE': 20, '409 ZONE_CAPACITY_EXCEEDED': BUYERS - 20 });
      assert.equal(zone.reservedCount, 20);
      for (const { res, body } of single) {
        if (res.status === 409)
          assert.deepEqual(body.details, { zoneId: s.general.id, available: 0 });
      }
      const general = availability.zones.find((z) => z.id === s.general.id);
      assert.deepEqual([general.available, general.soldOut], [0, true]);
      assert.equal((await zoneCounters(s.general.id)).reservedCount, 0);

      const triple = await reserveAll(s.buyers, {
        eventId: s.event.id,
        items: [{ zoneId: s.general.id, quantity: 3 }],
      });
      const tripleCounts = tally(triple);
      const after = await zoneCounters(s.general.id);
      await cancelAll(triple);
      console.log(
        `[concurrencia general x3] ${JSON.stringify(tripleCounts)} reservedCount=${after.reservedCount}/${after.capacity}`,
      );
      assert.deepEqual(tripleCounts, { '201 ACTIVE': 6, '409 ZONE_CAPACITY_EXCEEDED': BUYERS - 6 });
      assert.equal(after.reservedCount, 18);
      assert.equal((await zoneCounters(s.general.id)).reservedCount, 0);
    });

    test('concurrencia: un comprador con 10 solicitudes simultáneas -> una sola reserva ACTIVE', async () => {
      const token = s.buyers[1];
      const results = await reserveAll(
        Array.from({ length: 10 }, () => token),
        { eventId: s.event.id, items: [{ zoneId: s.pista.id, quantity: 1 }] },
      );
      const counts = tally(results);
      const pista = await zoneCounters(s.pista.id);
      await cancelAll(results);
      console.log(`[concurrencia mismo comprador] ${JSON.stringify(counts)}`);
      assert.deepEqual(counts, { '201 ACTIVE': 1, '409 ACTIVE_RESERVATION_EXISTS': 9 });
      const winner = results.find((r) => r.res.status === 201).body;
      for (const { res, body } of results) {
        if (res.status === 409) assert.deepEqual(body.details, { reservationId: winner.id });
      }
      assert.equal(pista.reservedCount, 1);
    });

    test('todo o nada: si un asiento falla no se reserva ninguno', async () => {
      const [a, b] = s.buyers;
      const first = await expectContract('POST', '/reservations', 201, {
        token: a,
        body: { eventId: s.event.id, items: [{ seatId: s.seats.A2 }, { seatId: s.seats.A3 }] },
      });
      assert.equal(first.total, '1000.00');
      const active = await expectContract('GET', '/reservations/active', 200, { token: a });
      assert.equal(active.id, first.id);
      const conflict = await expectContract('POST', '/reservations', 409, {
        token: b,
        body: {
          eventId: s.event.id,
          items: [
            { seatId: s.seats.A3 },
            { seatId: s.seats.B1 },
            { zoneId: s.general.id, quantity: 2 },
          ],
        },
      });
      assert.equal(conflict.code, 'SEAT_UNAVAILABLE');
      assert.deepEqual(conflict.details, { unavailableSeatIds: [s.seats.A3] });
      const full = await expectContract('POST', '/reservations', 400, {
        token: b,
        body: {
          eventId: s.event.id,
          items: [{ seatId: s.seats.B1 }, { zoneId: s.general.id, quantity: 10 }],
        },
      });
      assert.equal(full.code, 'TOO_MANY_TICKETS');
      const map = await expectContract(
        'GET',
        `/zones/${s.numbered.id}/seats`,
        200,
        {},
        '/zones/{zoneId}/seats',
      );
      const status = Object.fromEntries(
        map.rows.flatMap((r) => r.seats.map((seat) => [seat.id, seat.status])),
      );
      assert.equal(status[s.seats.B1], 'AVAILABLE');
      assert.equal((await zoneCounters(s.general.id)).reservedCount, 0);
      const mixed = await expectContract('POST', '/reservations', 201, {
        token: b,
        body: {
          eventId: s.event.id,
          items: [{ seatId: s.seats.B1 }, { zoneId: s.general.id, quantity: 2 }],
        },
      });
      assert.equal(mixed.total, '1001.00');
      assert.deepEqual(
        mixed.items.map((i) => [
          i.zoneName,
          i.seatId,
          i.rowLabel,
          i.seatNumber,
          i.quantity,
          i.unitPrice,
        ]),
        [
          ['Platea', s.seats.B1, 'B', 1, 1, '500.00'],
          ['General', null, null, null, 2, '250.50'],
        ],
      );
      s.resA = first;
      s.resB = mixed;
    });

    test('GET y cancelar: dueño -> 200; otro comprador -> 403; idempotente', async () => {
      const [a, b] = s.buyers;
      const got = await expectContract('GET', `/reservations/${s.resA.id}`, 200, { token: a }, tpl);
      assert.equal(got.status, 'ACTIVE');
      assert.ok(
        got.secondsRemaining > 590 && got.secondsRemaining <= 600,
        `${got.secondsRemaining}`,
      );
      assert.equal(
        Date.parse(got.expiresAt) - Date.parse(got.createdAt),
        10 * 60_000,
        'TTL de RESERVATION_TTL_MINUTES',
      );
      const foreign = await expectContract(
        'GET',
        `/reservations/${s.resA.id}`,
        403,
        { token: b },
        tpl,
      );
      assert.equal(foreign.code, 'FORBIDDEN');
      await expectContract(
        'POST',
        `/reservations/${s.resA.id}/cancel`,
        403,
        { token: b },
        `${tpl}/cancel`,
      );
      await expectContract('GET', '/reservations/999999999', 404, { token: a }, tpl);
      const cancelled = await expectContract(
        'POST',
        `/reservations/${s.resA.id}/cancel`,
        200,
        { token: a },
        `${tpl}/cancel`,
      );
      assert.deepEqual([cancelled.status, cancelled.secondsRemaining], ['CANCELLED', 0]);
      const again = await expectContract(
        'POST',
        `/reservations/${s.resA.id}/cancel`,
        200,
        { token: a },
        `${tpl}/cancel`,
      );
      assert.equal(again.status, 'CANCELLED');
      const map = await expectContract(
        'GET',
        `/zones/${s.numbered.id}/seats`,
        200,
        {},
        '/zones/{zoneId}/seats',
      );
      const status = Object.fromEntries(
        map.rows.flatMap((r) => r.seats.map((seat) => [seat.id, seat.status])),
      );
      assert.deepEqual(
        [status[s.seats.A2], status[s.seats.A3], status[s.seats.B1]],
        ['AVAILABLE', 'AVAILABLE', 'RESERVED'],
      );
    });
  });

  describe('Endpoints internos', () => {
    test('sin X-Internal-Token -> 401; el gateway no expone /internal', async () => {
      const { res } = await internalCall('GET', `/internal/reservations/${s.resB.id}`, {
        headers: {},
      });
      assert.equal(res.status, 401);
      const wrong = await internalCall('GET', `/internal/zones?eventId=${s.event.id}`, {
        headers: { 'x-internal-token': 'otro' },
      });
      assert.equal(wrong.res.status, 401);
      const viaGateway = await call('GET', `/internal/reservations/${s.resB.id}`, {
        headers: internal,
      });
      assert.equal(viaGateway.res.status, 404);
    });

    test('confirm-sale: vende asientos, idempotente con la misma compra, 409 con otra', async () => {
      const path = `/internal/reservations/${s.resB.id}`;
      const got = await expectInternal('GET', path, 200, INTERNAL_RESERVATION_SCHEMA);
      assert.deepEqual([got.status, got.purchaseId], ['ACTIVE', null]);
      const activeView = await expectContract(
        'GET',
        `/reservations/${s.resB.id}`,
        200,
        { token: s.buyers[1] },
        '/reservations/{reservationId}',
      );
      assert.deepEqual([activeView.status, activeView.purchaseId], ['ACTIVE', null]);
      const invalid = await expectInternal('POST', `${path}/confirm-sale`, 400, ERROR_SCHEMA, {
        body: { purchaseId: 'x' },
      });
      assert.equal(invalid.code, 'VALIDATION_ERROR');
      const purchaseId = Date.now();
      const confirmed = await expectInternal(
        'POST',
        `${path}/confirm-sale`,
        200,
        RESERVATION_SCHEMA,
        {
          body: { purchaseId },
        },
      );
      assert.deepEqual([confirmed.status, confirmed.secondsRemaining], ['CONFIRMED', 0]);
      const repeat = await expectInternal('POST', `${path}/confirm-sale`, 200, RESERVATION_SCHEMA, {
        body: { purchaseId },
      });
      assert.equal(repeat.status, 'CONFIRMED');
      const confirmedView = await expectInternal('GET', path, 200, INTERNAL_RESERVATION_SCHEMA);
      assert.deepEqual([confirmedView.status, confirmedView.purchaseId], ['CONFIRMED', purchaseId]);
      const publicView = await expectContract(
        'GET',
        `/reservations/${s.resB.id}`,
        200,
        { token: s.buyers[1] },
        '/reservations/{reservationId}',
      );
      assert.deepEqual([publicView.status, publicView.purchaseId], ['CONFIRMED', purchaseId]);
      const other = await expectInternal('POST', `${path}/confirm-sale`, 409, ERROR_SCHEMA, {
        body: { purchaseId: purchaseId + 1 },
      });
      assert.deepEqual(
        [other.code, other.details],
        ['INVALID_RESERVATION_STATE', { status: 'CONFIRMED' }],
      );
      const release = await expectInternal('POST', `${path}/release`, 409, ERROR_SCHEMA);
      assert.equal(release.code, 'RESERVATION_ALREADY_CONFIRMED');
      const cancel = await expectContract(
        'POST',
        `/reservations/${s.resB.id}/cancel`,
        409,
        { token: s.buyers[1] },
        '/reservations/{reservationId}/cancel',
      );
      assert.equal(cancel.code, 'RESERVATION_ALREADY_CONFIRMED');
      const general = await zoneCounters(s.general.id);
      const numbered = await zoneCounters(s.numbered.id);
      assert.deepEqual([general.reservedCount, general.soldCount], [0, 2]);
      assert.deepEqual([numbered.reservedCount, numbered.soldCount], [0, 1]);
      const map = await expectContract(
        'GET',
        `/zones/${s.numbered.id}/seats`,
        200,
        {},
        '/zones/{zoneId}/seats',
      );
      const sold = map.rows.flatMap((r) => r.seats).filter((seat) => seat.status === 'SOLD');
      assert.deepEqual(
        sold.map((seat) => seat.id),
        [s.seats.B1],
      );

      const second = await expectContract('POST', '/reservations', 201, {
        token: s.buyers[1],
        body: { eventId: s.event.id, items: [{ seatId: s.seats.B2 }] },
      });
      const used = await expectInternal(
        'POST',
        `/internal/reservations/${second.id}/confirm-sale`,
        409,
        ERROR_SCHEMA,
        { body: { purchaseId } },
      );
      assert.equal(used.code, 'INVALID_RESERVATION_STATE');
      s.second = second;
    });

    test('release: cancela una ACTIVE e idempotente; 404 si no existe', async () => {
      const path = `/internal/reservations/${s.second.id}/release`;
      const released = await expectInternal('POST', path, 200, RESERVATION_SCHEMA);
      assert.equal(released.status, 'CANCELLED');
      const again = await expectInternal('POST', path, 200, RESERVATION_SCHEMA);
      assert.equal(again.status, 'CANCELLED');
      const missing = await expectInternal(
        'POST',
        '/internal/reservations/999999999/release',
        404,
        ERROR_SCHEMA,
      );
      assert.equal(missing.code, 'RESERVATION_NOT_FOUND');
    });

    test('GET /internal/zones: por ids o por eventId, exactamente uno', async () => {
      const byIds = await expectInternal(
        'GET',
        `/internal/zones?ids=${s.pista.id},999999999,${s.numbered.id}`,
        200,
        ZONES_SCHEMA,
      );
      assert.deepEqual(
        byIds.map((z) => z.id),
        [s.pista.id, s.numbered.id],
      );
      const byEvent = await expectInternal(
        'GET',
        `/internal/zones?eventId=${s.event.id}`,
        200,
        ZONES_SCHEMA,
      );
      assert.equal(byEvent.length, 3);
      for (const query of ['', `?ids=${s.pista.id}&eventId=${s.event.id}`, '?eventId=abc']) {
        const err = await expectInternal('GET', `/internal/zones${query}`, 400, ERROR_SCHEMA);
        assert.equal(err.code, 'VALIDATION_ERROR');
      }
      const tooMany = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
      await expectInternal('GET', `/internal/zones?ids=${tooMany}`, 400, ERROR_SCHEMA);
    });

    test('zona con ventas: no se borra, no baja de lo comprometido, no se regenera el plano', async () => {
      const deleted = await expectContract(
        'DELETE',
        `/zones/${s.numbered.id}`,
        409,
        { token: s.orgA.token },
        '/zones/{zoneId}',
      );
      assert.equal(deleted.code, 'ZONE_HAS_SALES');
      const below = await expectContract(
        'PUT',
        `/zones/${s.general.id}`,
        409,
        {
          token: s.orgA.token,
          body: { name: 'General', type: 'GENERAL', price: '250.50', capacity: 1 },
        },
        '/zones/{zoneId}',
      );
      assert.deepEqual([below.code, below.details], ['CAPACITY_BELOW_COMMITTED', { committed: 2 }]);
      const resize = await expectContract(
        'PUT',
        `/zones/${s.numbered.id}`,
        409,
        {
          token: s.orgA.token,
          body: { name: 'Platea', type: 'NUMBERED', price: '500.00', capacity: 8 },
        },
        '/zones/{zoneId}',
      );
      assert.equal(resize.code, 'ZONE_HAS_SALES');
      const layout = await expectContract(
        'POST',
        `/zones/${s.numbered.id}/seats`,
        409,
        { token: s.orgA.token, body: { rows: [{ rowLabel: 'A', seatCount: 6 }] } },
        '/zones/{zoneId}/seats',
      );
      assert.equal(layout.code, 'ZONE_HAS_SALES');
      const renamed = await expectContract(
        'PUT',
        `/zones/${s.numbered.id}`,
        200,
        {
          token: s.orgA.token,
          body: { name: 'Platea Alta', type: 'NUMBERED', price: '550.00', capacity: 6 },
        },
        '/zones/{zoneId}',
      );
      assert.deepEqual(
        [renamed.name, renamed.price, renamed.soldCount],
        ['Platea Alta', '550.00', 1],
      );
    });
  });

  describe('Vencimiento', () => {
    test('TTL corto (3 s): al leer la reserva vencida, libera el asiento y responde 410', async () => {
      const token = s.buyers[2];
      const reservation = await call('POST', '/reservations', {
        base: INVENTORY_LAZY,
        token,
        body: { eventId: s.event.id, items: [{ seatId: s.seats.B3 }] },
      });
      assert.equal(reservation.res.status, 201, JSON.stringify(reservation.body));
      assertSchema(RESERVATION_SCHEMA, reservation.body, 'reserva corta');
      const { id, createdAt, expiresAt, secondsRemaining } = reservation.body;
      assert.equal(Date.parse(expiresAt) - Date.parse(createdAt), 3000);
      assert.ok(secondsRemaining >= 1 && secondsRemaining <= 3, `${secondsRemaining}`);
      assert.equal((await zoneCounters(s.numbered.id)).reservedCount, 1);
      await sleep(Date.parse(expiresAt) - Date.now() + 1200);
      const got = await expectContract(
        'GET',
        `/reservations/${id}`,
        200,
        { token },
        '/reservations/{reservationId}',
      );
      assert.deepEqual([got.status, got.secondsRemaining], ['EXPIRED', 0]);
      assert.equal((await zoneCounters(s.numbered.id)).reservedCount, 0);
      const cancel = await expectContract(
        'POST',
        `/reservations/${id}/cancel`,
        410,
        { token },
        '/reservations/{reservationId}/cancel',
      );
      assert.deepEqual([cancel.code, cancel.message], ['RESERVATION_EXPIRED', 'Tiempo agotado']);
      const confirm = await expectInternal(
        'POST',
        `/internal/reservations/${id}/confirm-sale`,
        410,
        ERROR_SCHEMA,
        {
          body: { purchaseId: 1 },
        },
      );
      assert.equal(confirm.code, 'RESERVATION_EXPIRED');
      await expectContract('GET', '/reservations/active', 404, { token });
      const retake = await expectContract('POST', '/reservations', 201, {
        token: s.buyers[3],
        body: { eventId: s.event.id, items: [{ seatId: s.seats.B3 }] },
      });
      await cancelAll([{ res: { status: 201 }, body: retake, token: s.buyers[3] }]);
    });

    test('barrido periódico (TTL 3 s, cada 1 s): libera contadores sin que nadie lea la reserva', async () => {
      const token = s.buyers[4];
      const before = (await zoneCounters(s.pista.id)).reservedCount;
      const created = await call('POST', '/reservations', {
        base: INVENTORY_SWEEP,
        token,
        body: { eventId: s.event.id, items: [{ zoneId: s.pista.id, quantity: 4 }] },
      });
      assert.equal(created.res.status, 201, JSON.stringify(created.body));
      assert.equal((await zoneCounters(s.pista.id)).reservedCount, before + 4);
      const started = Date.now();
      let counters;
      do {
        await sleep(500);
        counters = await zoneCounters(s.pista.id);
      } while (counters.reservedCount !== before && Date.now() - started < 10_000);
      console.log(
        `[barrido] reservedCount volvió a ${counters.reservedCount} en ${Date.now() - started} ms (TTL 3000 ms)`,
      );
      assert.equal(counters.reservedCount, before);
      const got = await expectInternal(
        'GET',
        `/internal/reservations/${created.body.id}`,
        200,
        INTERNAL_RESERVATION_SCHEMA,
      );
      assert.equal(got.status, 'EXPIRED');
    });
  });

  describe('Integración con Catalog', () => {
    test('evento cancelado -> disponibilidad y reserva 410; crear zona 409 INVALID_EVENT_STATE', async () => {
      await setStatus(s.other.id, 'CANCELLED');
      const tpl = '/events/{eventId}/availability';
      const gone = await expectContract('GET', `/events/${s.other.id}/availability`, 410, {}, tpl);
      assert.equal(gone.code, 'EVENT_NOT_AVAILABLE');
      const seats = await expectContract(
        'GET',
        `/zones/${s.otherSeats.id}/seats`,
        410,
        {},
        '/zones/{zoneId}/seats',
      );
      assert.equal(seats.code, 'EVENT_NOT_AVAILABLE');
      const reserve = await expectContract('POST', '/reservations', 410, {
        token: s.buyers[5],
        body: { eventId: s.other.id, items: [{ seatId: s.foreignSeat }] },
      });
      assert.equal(reserve.code, 'EVENT_NOT_AVAILABLE');
      const locked = await expectContract(
        'POST',
        `/events/${s.other.id}/zones`,
        409,
        {
          token: s.orgA.token,
          body: { name: 'Nueva', type: 'GENERAL', price: '1.00', capacity: 1 },
        },
        zonePath,
      );
      assert.deepEqual(
        [locked.code, locked.details],
        ['INVALID_EVENT_STATE', { status: 'CANCELLED' }],
      );
    });

    test('publicar exige zonas reales y borrar un borrador elimina sus zonas', async () => {
      const draft = await newEvent(s.orgA.token, 'Borrador');
      const empty = await expectContract(
        'PATCH',
        `/events/${draft.id}/status`,
        409,
        { token: s.orgA.token, body: { status: 'PUBLISHED' } },
        '/events/{eventId}/status',
      );
      assert.equal(empty.code, 'EVENT_HAS_NO_ZONES');
      const zone = await addZone(draft.id, {
        name: 'Única',
        type: 'NUMBERED',
        price: '10.00',
        capacity: 2,
      });
      await expectContract(
        'POST',
        `/zones/${zone.id}/seats`,
        201,
        { token: s.orgA.token, body: { rows: [{ rowLabel: 'A', seatCount: 2 }] } },
        '/zones/{zoneId}/seats',
      );
      await expectContract(
        'DELETE',
        `/events/${draft.id}`,
        204,
        { token: s.orgA.token },
        '/events/{eventId}',
      );
      assert.deepEqual(
        await expectInternal('GET', `/internal/zones?eventId=${draft.id}`, 200, ZONES_SCHEMA),
        [],
      );
      const { res } = await internalCall('DELETE', `/internal/events/${draft.id}/zones`);
      assert.equal(res.status, 204, 'idempotente');
    });
  });

  describe('Catalog no disponible', () => {
    test('toda operación que consulta a Catalog -> 503 SERVICE_UNAVAILABLE según el contrato', async () => {
      const base = INVENTORY_NOCATALOG;
      const org = s.orgA.token;
      const zoneBody = { name: 'Z', type: 'GENERAL', price: '1.00', capacity: 1 };
      const cases = [
        ['GET', `/events/${s.event.id}/availability`, '/events/{eventId}/availability', {}],
        ['GET', `/zones/${s.numbered.id}/seats`, '/zones/{zoneId}/seats', {}],
        ['GET', `/events/${s.event.id}/zones`, zonePath, { token: org }],
        ['POST', `/events/${s.event.id}/zones`, zonePath, { token: org, body: zoneBody }],
        ['PUT', `/zones/${s.pista.id}`, '/zones/{zoneId}', { token: org, body: zoneBody }],
        ['DELETE', `/zones/${s.pista.id}`, '/zones/{zoneId}', { token: org }],
        [
          'POST',
          `/zones/${s.numbered.id}/seats`,
          '/zones/{zoneId}/seats',
          { token: org, body: { rows: [{ rowLabel: 'A', seatCount: 6 }] } },
        ],
        [
          'POST',
          '/reservations',
          '/reservations',
          {
            token: s.buyers[6],
            body: { eventId: s.event.id, items: [{ zoneId: s.pista.id, quantity: 1 }] },
          },
        ],
      ];
      for (const [method, path, template, options] of cases) {
        const err = await expectContract(method, path, 503, { ...options, base }, template);
        assert.equal(err.code, 'SERVICE_UNAVAILABLE', `${method} ${path}`);
      }
      assert.equal((await zoneCounters(s.pista.id)).name, 'Pista VIP', 'no se modificó');
      await expectContract('GET', '/reservations/active', 404, { token: s.buyers[6], base });
    });
  });
});
