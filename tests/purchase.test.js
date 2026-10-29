import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { assertContract, assertSchema } from './contract.js';
import { fakes, STRIPE_KEY, startFakes } from './fakes.js';
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
  login,
  PURCHASE,
  PURCHASE_ISOLATED,
  PURCHASE_SHORTCLAIM,
  RUN,
} from './helpers.js';

const internal = { 'x-internal-token': INTERNAL_TOKEN };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inDays = (days) =>
  new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
const SALES_STATS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['purchases', 'grossRevenue', 'currency'],
  properties: {
    purchases: { type: 'integer' },
    grossRevenue: { type: 'string', pattern: '^\\d+\\.\\d{2}$' },
    currency: { type: 'string', enum: ['MXN'] },
  },
};

const pay = (token, reservationId, paymentMethodToken, status, base) =>
  expectContract(
    'POST',
    '/purchases',
    status,
    { token, base, body: { reservationId, paymentMethodToken } },
    '/purchases',
  );

const chargesOf = (reservationId) =>
  fakes.stripe.charges.filter((charge) => charge.reservationId === reservationId);
const netChargesOf = (reservationId) =>
  chargesOf(reservationId).filter((c) => c.status === 'succeeded' && !c.refunded);
const orphansOf = (reservationId) =>
  chargesOf(reservationId).filter((c) => c.status === 'requires_capture');

async function waitFor(check, ms = 15000) {
  const started = Date.now();
  while (!check() && Date.now() - started < ms) await sleep(200);
  return check();
}
const intentRequestsOf = (reservationId) =>
  fakes.stripe.requests.filter(
    (r) =>
      r.path === '/v1/payment_intents' &&
      Number(r.params['metadata[reservation_id]']) === reservationId,
  );

async function internalReservation(id) {
  const { res, body } = await call('GET', `/internal/reservations/${id}`, {
    base: INVENTORY,
    headers: internal,
  });
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

describe('PurchaseService (purchase.yaml)', () => {
  const s = {};
  let fakeServer;

  const reserve = (token, items, base) =>
    expectContract(
      'POST',
      '/reservations',
      201,
      { token, base, body: { eventId: s.event.id, items } },
      '/reservations',
    );
  const seat = (n) => ({ seatId: s.seats[n] });

  before(async () => {
    fakeServer = await startFakes(Number(process.env.FAKES_PORT ?? 4100), INTERNAL_TOKEN);
    s.admin = (await login(ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    s.org = await createOrganizer(s.admin, 'pur-org');
    s.otherOrg = await createOrganizer(s.admin, 'pur-org-b');
    const venue = await expectContract('POST', '/venues', 201, {
      token: s.org.token,
      body: { name: `Foro ${RUN}`, address: 'Calle 2', city: 'Zapopan' },
    });
    s.event = await expectContract('POST', '/events', 201, {
      token: s.org.token,
      body: {
        venueId: venue.id,
        title: `Compras ${RUN}`,
        description: 'Evento de prueba de compras.',
        category: 'CONCERT',
        startsAt: inDays(15),
      },
    });
    const zone = (body) =>
      expectContract(
        'POST',
        `/events/${s.event.id}/zones`,
        201,
        { token: s.org.token, body },
        '/events/{eventId}/zones',
      );
    s.platea = await zone({ name: 'Platea', type: 'NUMBERED', price: '500.00', capacity: 12 });
    s.general = await zone({ name: 'General', type: 'GENERAL', price: '250.00', capacity: 100 });
    const map = await expectContract(
      'POST',
      `/zones/${s.platea.id}/seats`,
      201,
      { token: s.org.token, body: { rows: [{ rowLabel: 'A', seatCount: 12 }] } },
      '/zones/{zoneId}/seats',
    );
    s.seats = Object.fromEntries(map.rows[0].seats.map((seat) => [seat.seatNumber, seat.id]));
    await expectContract(
      'PATCH',
      `/events/${s.event.id}/status`,
      200,
      { token: s.org.token, body: { status: 'PUBLISHED' } },
      '/events/{eventId}/status',
    );
    s.buyers = [];
    s.buyerIds = [];
    for (let i = 0; i < 19; i++) {
      const account = { name: `Comprador ${i}`, email: email(`pur-${i}`), password: 'S3gura!2026' };
      s.buyerIds.push((await expectContract('POST', '/auth/register', 201, { body: account })).id);
      s.buyers.push((await login(account.email, account.password)).accessToken);
    }
  });

  after(() => fakeServer?.close());

  test('POST /purchases: sin token 401, otro rol 403, inválido 400, reserva inexistente 404, ajena 403', async () => {
    await expectContract('POST', '/purchases', 401, {
      body: { reservationId: 1, paymentMethodToken: 'pm_card_visa' },
    });
    const organizer = await pay(s.org.token, 1, 'pm_card_visa', 403);
    assert.equal(organizer.code, 'FORBIDDEN');
    const invalid = await expectContract('POST', '/purchases', 400, {
      token: s.buyers[0],
      body: { reservationId: 'x', paymentMethodToken: '' },
    });
    assert.deepEqual(invalid.details.fields.map((f) => f.field).sort(), [
      'paymentMethodToken',
      'reservationId',
    ]);
    const missing = await pay(s.buyers[0], 999999999, 'pm_card_visa', 404);
    assert.equal(missing.code, 'RESERVATION_NOT_FOUND');
    const foreign = await reserve(s.buyers[9], [seat(12)]);
    const notMine = await pay(s.buyers[0], foreign.id, 'pm_card_visa', 403);
    assert.equal(notMine.code, 'FORBIDDEN');
    await expectContract(
      'POST',
      `/reservations/${foreign.id}/cancel`,
      200,
      { token: s.buyers[9] },
      '/reservations/{reservationId}/cancel',
    );
    assert.equal(intentRequestsOf(foreign.id).length, 0, 'no se llamó a Stripe');
  });

  test('compra exitosa: cobra el total de la reserva, vende los asientos y emite boletos', async () => {
    const token = s.buyers[0];
    const reservation = await reserve(token, [seat(1), { zoneId: s.general.id, quantity: 2 }]);
    const result = await pay(token, reservation.id, 'pm_card_visa', 201);
    const { purchase } = result;
    assert.deepEqual(
      {
        reservationId: purchase.reservationId,
        userId: purchase.userId,
        eventId: purchase.eventId,
        total: purchase.total,
        currency: purchase.currency,
        paymentProvider: purchase.paymentProvider,
        status: purchase.status,
        failedAttempts: purchase.failedAttempts,
      },
      {
        reservationId: reservation.id,
        userId: s.buyerIds[0],
        eventId: s.event.id,
        total: '1000.00',
        currency: 'MXN',
        paymentProvider: 'stripe',
        status: 'PAID',
        failedAttempts: 0,
      },
    );
    assert.match(purchase.paymentReference, /^pi_/);
    assert.equal(result.ticketIssuance, 'ISSUED');
    assert.equal(result.ticketIds.length, 3);
    const [request] = intentRequestsOf(reservation.id);
    assert.equal(request.authorization, `Bearer ${STRIPE_KEY}`);
    assert.equal(request.contentType, 'application/x-www-form-urlencoded');
    assert.match(
      request.idempotencyKey,
      new RegExp(`^tickethub-reservation-${reservation.id}-attempt-1$`),
    );
    assert.deepEqual(
      [
        request.params.amount,
        request.params.currency,
        request.params.payment_method,
        request.params.confirm,
        request.params.capture_method,
      ],
      ['100000', 'mxn', 'pm_card_visa', 'true', 'manual'],
    );
    const ticketCall = fakes.tickets.calls.find((c) => c.purchaseId === purchase.id);
    assert.deepEqual(ticketCall, {
      purchaseId: purchase.id,
      userId: s.buyerIds[0],
      eventId: s.event.id,
      items: [
        { zoneId: s.platea.id, seatId: s.seats[1], quantity: 1 },
        { zoneId: s.general.id, seatId: null, quantity: 2 },
      ],
    });
    const confirmed = await internalReservation(reservation.id);
    assert.equal(confirmed.status, 'CONFIRMED');
    const again = await pay(token, reservation.id, 'pm_card_visa', 409);
    assert.deepEqual(
      [again.code, again.details],
      ['RESERVATION_ALREADY_PAID', { purchaseId: purchase.id }],
    );
    assert.equal(netChargesOf(reservation.id).length, 1);
    assert.equal(orphansOf(reservation.id).length, 0);
    const got = await expectContract(
      'GET',
      `/purchases/${purchase.id}`,
      200,
      { token },
      '/purchases/{purchaseId}',
    );
    assert.deepEqual(got, purchase);
    const foreign = await expectContract(
      'GET',
      `/purchases/${purchase.id}`,
      403,
      { token: s.buyers[1] },
      '/purchases/{purchaseId}',
    );
    assert.equal(foreign.code, 'FORBIDDEN');
    const none = await expectContract(
      'GET',
      '/purchases/999999999',
      404,
      { token },
      '/purchases/{purchaseId}',
    );
    assert.equal(none.code, 'PURCHASE_NOT_FOUND');
    const mine = await expectContract('GET', '/purchases/me', 200, { token });
    assert.deepEqual(mine.items, [purchase]);
    assert.equal(mine.totalItems, 1);
    await expectContract('GET', '/purchases/me', 403, { token: s.org.token });
    s.paid = [purchase];
  });

  test('pago declinado: 402 con intentos restantes; el reintento aprobado usa el mismo renglón', async () => {
    const token = s.buyers[1];
    const reservation = await reserve(token, [seat(2)]);
    const declined = await pay(token, reservation.id, 'pm_card_chargeDeclined', 402);
    assert.deepEqual(
      [declined.code, declined.details],
      ['PAYMENT_DECLINED', { attemptsRemaining: 2, providerDeclineCode: 'generic_decline' }],
    );
    const unknownCard = await pay(token, reservation.id, 'pm_no_existe', 402);
    assert.deepEqual(unknownCard.details, {
      attemptsRemaining: 1,
      providerDeclineCode: 'resource_missing',
    });
    assert.equal((await internalReservation(reservation.id)).status, 'ACTIVE');
    const ok = await pay(token, reservation.id, 'pm_card_visa', 201);
    assert.deepEqual([ok.purchase.status, ok.purchase.failedAttempts], ['PAID', 2]);
    const keys = intentRequestsOf(reservation.id).map((r) =>
      r.idempotencyKey.split('-').slice(0, 5).join('-'),
    );
    assert.deepEqual(
      keys,
      [1, 2, 3].map((n) => `tickethub-reservation-${reservation.id}-attempt-${n}`),
    );
    s.paid.push(ok.purchase);
  });

  test('3 intentos fallidos: PAYMENT_ATTEMPTS_EXHAUSTED y la reserva se libera', async () => {
    const token = s.buyers[2];
    const reservation = await reserve(token, [seat(3)]);
    const remaining = [];
    for (let i = 0; i < 2; i++) {
      remaining.push(
        (await pay(token, reservation.id, 'pm_card_chargeDeclined', 402)).details.attemptsRemaining,
      );
    }
    assert.deepEqual(remaining, [2, 1]);
    const last = await pay(token, reservation.id, 'pm_card_insufficientFunds', 402);
    assert.deepEqual(
      [last.code, last.details],
      ['PAYMENT_ATTEMPTS_EXHAUSTED', { attemptsRemaining: 0 }],
    );
    const released = await internalReservation(reservation.id);
    assert.equal(released.status, 'CANCELLED');
    const map = await expectContract(
      'GET',
      `/zones/${s.platea.id}/seats`,
      200,
      {},
      '/zones/{zoneId}/seats',
    );
    assert.equal(map.rows[0].seats.find((x) => x.id === s.seats[3]).status, 'AVAILABLE');
    const after = await pay(token, reservation.id, 'pm_card_visa', 402);
    assert.equal(after.code, 'PAYMENT_ATTEMPTS_EXHAUSTED');
    assert.equal(intentRequestsOf(reservation.id).length, 3, 'no hubo un cuarto cobro');
    assert.equal(chargesOf(reservation.id).length, 0);
  });

  test('Stripe caído -> 503 PAYMENT_GATEWAY_UNAVAILABLE; respuesta inválida -> 502; sin cobro ni intento', async () => {
    const token = s.buyers[3];
    const reservation = await reserve(token, [seat(4)]);
    fakes.stripe.mode = 'down';
    try {
      const down = await pay(token, reservation.id, 'pm_card_visa', 503);
      assert.deepEqual(
        [down.code, down.message],
        ['PAYMENT_GATEWAY_UNAVAILABLE', 'Pasarela no disponible'],
      );
      fakes.stripe.mode = 'garbage';
      const garbage = await pay(token, reservation.id, 'pm_card_visa', 502);
      assert.equal(garbage.code, 'PAYMENT_GATEWAY_ERROR');
    } finally {
      fakes.stripe.mode = 'normal';
    }
    assert.equal((await internalReservation(reservation.id)).status, 'ACTIVE');
    const mine = await expectContract('GET', '/purchases/me', 200, { token });
    assert.equal(mine.totalItems, 0);
    s.downReservation = reservation;
  });

  test('timeout de Stripe tras cobrar: 503 y el reintento reutiliza la llave de idempotencia (un solo cargo)', async () => {
    const token = s.buyers[3];
    const reservation = s.downReservation;
    fakes.stripe.delayMs = 2500;
    const started = Date.now();
    try {
      const timeout = await pay(token, reservation.id, 'pm_card_visa', 503);
      assert.equal(timeout.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
      assert.ok(Date.now() - started < 2500, 'respondió por timeout');
    } finally {
      fakes.stripe.delayMs = 0;
    }
    assert.equal(chargesOf(reservation.id).length, 1, 'Stripe sí registró la autorización');
    await sleep(Math.max(0, 2700 - (Date.now() - started)));
    const replaysBefore = fakes.stripe.replays;
    const retry = await pay(token, reservation.id, 'pm_card_visa', 201);
    assert.equal(retry.purchase.paymentReference, chargesOf(reservation.id)[0].id);
    assert.equal(retry.purchase.failedAttempts, 0);
    assert.equal(chargesOf(reservation.id).length, 1, 'sin doble autorización');
    assert.equal(netChargesOf(reservation.id).length, 1, 'un cargo neto');
    assert.equal(orphansOf(reservation.id).length, 0);
    assert.equal(fakes.stripe.replays, replaysBefore + 1);
    const keys = new Set(intentRequestsOf(reservation.id).map((r) => r.idempotencyKey));
    assert.equal(keys.size, 1);
    console.log(
      `[timeout] solicitudes a Stripe=${intentRequestsOf(reservation.id).length} cargos=${chargesOf(reservation.id).length} repeticiones idempotentes=${fakes.stripe.replays - replaysBefore}`,
    );
    s.paid.push(retry.purchase);
  });

  test('concurrencia: 10 pagos simultáneos de la misma reserva -> una compra y un cargo', async () => {
    const token = s.buyers[4];
    const reservation = await reserve(token, [seat(5), { zoneId: s.general.id, quantity: 1 }]);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        call('POST', '/purchases', {
          token,
          body: { reservationId: reservation.id, paymentMethodToken: 'pm_card_visa' },
        }),
      ),
    );
    const counts = {};
    for (const { res, body } of results) {
      assertContract(res, body, 'POST', '/api/v1/purchases', res.status);
      const key = `${res.status} ${body.code ?? body.purchase.status}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const winner = results.find((r) => r.res.status === 201).body.purchase;
    console.log(
      `[concurrencia compra] ${JSON.stringify(counts)} solicitudes a Stripe=${intentRequestsOf(reservation.id).length} cargos=${chargesOf(reservation.id).length}`,
    );
    assert.deepEqual(counts, { '201 PAID': 1, '409 RESERVATION_ALREADY_PAID': 9 });
    for (const { res, body } of results) {
      if (res.status === 409) assert.deepEqual(body.details, { purchaseId: winner.id });
    }
    assert.equal(chargesOf(reservation.id).length, 1);
    assert.equal(intentRequestsOf(reservation.id).length, 1);
    assert.equal(fakes.tickets.calls.filter((c) => c.purchaseId === winner.id).length, 1);
    s.paid.push(winner);
  });

  test('reserva vencida -> 410 sin cobro; cancelada -> 409 RESERVATION_NOT_ACTIVE', async () => {
    const token = s.buyers[5];
    const short = await reserve(token, [seat(6)], INVENTORY_LAZY);
    await sleep(Date.parse(short.expiresAt) - Date.now() + 1200);
    const expired = await pay(token, short.id, 'pm_card_visa', 410);
    assert.deepEqual([expired.code, expired.message], ['RESERVATION_EXPIRED', 'Tiempo agotado']);
    assert.equal(intentRequestsOf(short.id).length, 0);
    const cancelled = await reserve(token, [seat(7)]);
    await expectContract(
      'POST',
      `/reservations/${cancelled.id}/cancel`,
      200,
      { token },
      '/reservations/{reservationId}/cancel',
    );
    const notActive = await pay(token, cancelled.id, 'pm_card_visa', 409);
    assert.equal(notActive.code, 'RESERVATION_NOT_ACTIVE');
  });

  test('la reserva vence durante la autorización -> se cancela la autorización y responde 410', async () => {
    const token = s.buyers[6];
    const short = await reserve(token, [seat(8)], INVENTORY_LAZY);
    await sleep(Math.max(0, Date.parse(short.expiresAt) - Date.now() - 1000));
    fakes.stripe.delayMs = 1400;
    try {
      const expired = await pay(token, short.id, 'pm_card_visa', 410);
      assert.equal(expired.code, 'RESERVATION_EXPIRED');
    } finally {
      fakes.stripe.delayMs = 0;
    }
    const [charge] = chargesOf(short.id);
    assert.ok(charge, 'hubo autorización');
    assert.equal(charge.status, 'canceled', 'y se canceló sin capturar');
    assert.equal(netChargesOf(short.id).length, 0);
    const mine = await expectContract('GET', '/purchases/me', 200, { token });
    assert.equal(mine.totalItems, 0);
    console.log(`[vence durante la autorización] ${charge.id} cancelada`);
  });

  test('la cancelación falla -> queda pendiente y el barrido la reintenta', async () => {
    const token = s.buyers[6];
    const short = await reserve(token, [seat(9)], INVENTORY_LAZY);
    await sleep(Math.max(0, Date.parse(short.expiresAt) - Date.now() - 1000));
    fakes.stripe.delayMs = 1400;
    fakes.stripe.failCancels = true;
    try {
      const expired = await pay(token, short.id, 'pm_card_visa', 410);
      assert.equal(expired.code, 'RESERVATION_EXPIRED');
    } finally {
      fakes.stripe.delayMs = 0;
    }
    const [charge] = chargesOf(short.id);
    assert.equal(charge.status, 'requires_capture', 'la cancelación falló');
    const failedCancels = fakes.stripe.requests.filter(
      (r) => r.path === `/v1/payment_intents/${charge.id}/cancel`,
    ).length;
    assert.ok(failedCancels >= 1);
    fakes.stripe.failCancels = false;
    const started = Date.now();
    assert.ok(await waitFor(() => charge.status === 'canceled'), 'el barrido canceló');
    assert.equal(netChargesOf(short.id).length, 0);
    console.log(`[barrido] cancelación reintentada en ${Date.now() - started} ms`);
  });

  test('TicketService falla -> PAID con ticketIssuance PENDING; otro proceso sin memoria lo emite desde la BD', async () => {
    const token = s.buyers[7];
    const reservation = await reserve(token, [{ zoneId: s.general.id, quantity: 3 }]);
    fakes.tickets.up = false;
    let result;
    try {
      result = await pay(token, reservation.id, 'pm_card_visa', 201);
    } finally {
      fakes.tickets.up = true;
    }
    assert.deepEqual(
      [result.purchase.status, result.ticketIssuance, result.ticketIds],
      ['PAID', 'PENDING', []],
    );
    const started = Date.now();
    while (!fakes.tickets.issued.has(result.purchase.id) && Date.now() - started < 8000) {
      await sleep(200);
    }
    const issued = fakes.tickets.issued.get(result.purchase.id);
    assert.equal(issued?.length, 3, 'reintento emitió los boletos');
    console.log(`[boletos] emitidos por reintento en ${Date.now() - started} ms`);
    s.paid.push(result.purchase);
  });

  test('timeout con pm_delay3000 y reintento con otra tarjeta -> 1 cargo neto y 0 huérfanas', async () => {
    const token = s.buyers[8];
    const reservation = await reserve(token, [{ zoneId: s.general.id, quantity: 1 }]);
    const started = Date.now();
    const timeout = await pay(token, reservation.id, 'pm_delay3000', 503);
    assert.equal(timeout.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
    assert.ok(Date.now() - started < 2500, 'respondió por timeout');
    const inUseBefore = fakes.stripe.inUse ?? 0;
    const busy = await pay(token, reservation.id, 'pm_card_visa', 503);
    assert.equal(busy.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
    assert.equal(
      fakes.stripe.inUse,
      inUseBefore + 1,
      'Stripe respondió 409 idempotency_key_in_use',
    );
    await sleep(Math.max(0, 3200 - (Date.now() - started)));
    const retry = await pay(token, reservation.id, 'pm_card_visa', 201);
    const [slow] = chargesOf(reservation.id);
    assert.equal(slow.paymentMethod, 'pm_delay3000');
    assert.equal(retry.purchase.paymentReference, slow.id);
    assert.equal(chargesOf(reservation.id).length, 1);
    assert.equal(netChargesOf(reservation.id).length, 1);
    assert.equal(orphansOf(reservation.id).length, 0);
    const requests = intentRequestsOf(reservation.id);
    assert.ok(requests.every((r) => r.params.payment_method === 'pm_delay3000'));
    assert.equal(new Set(requests.map((r) => r.idempotencyKey)).size, 1);
    console.log(
      `[timeout + otra tarjeta] 409 en uso=1 solicitudes=${requests.length} autorizaciones=${chargesOf(reservation.id).length} cargos netos=${netChargesOf(reservation.id).length} huérfanas=${orphansOf(reservation.id).length}`,
    );
    s.paid.push(retry.purchase);
  });

  test('timeout sin reintento -> el barrido concilia y cancela la autorización huérfana', async () => {
    const token = s.buyers[9];
    const reservation = await reserve(token, [{ zoneId: s.general.id, quantity: 1 }]);
    await pay(token, reservation.id, 'pm_delay3000', 503);
    assert.ok(await waitFor(() => chargesOf(reservation.id)[0]?.status === 'canceled'));
    assert.equal(chargesOf(reservation.id).length, 1);
    assert.equal(netChargesOf(reservation.id).length, 0);
    assert.equal(orphansOf(reservation.id).length, 0);
    await expectContract(
      'POST',
      `/reservations/${reservation.id}/cancel`,
      200,
      { token },
      '/reservations/{reservationId}/cancel',
    );
  });

  test('Inventory caído -> 503 SERVICE_UNAVAILABLE sin cobrar', async () => {
    const requests = fakes.stripe.requests.length;
    const down = await pay(s.buyers[8], 1, 'pm_card_visa', 503, PURCHASE_ISOLATED);
    assert.equal(down.code, 'SERVICE_UNAVAILABLE');
    assert.equal(fakes.stripe.requests.length, requests);
  });

  test('GET /events/{id}/sales (CU-13): dueño 200; otro organizador 403; Catalog caído 503', async () => {
    const path = `/events/${s.event.id}/sales`;
    const tpl = '/events/{eventId}/sales';
    const sales = await expectContract('GET', path, 200, { token: s.org.token }, tpl);
    const cents = (m) => Number(m.replace('.', ''));
    const gross = s.paid.reduce((sum, p) => sum + cents(p.total), 0);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(
      new Date(),
    );
    const platea = sales.byZone.find((z) => z.zoneId === s.platea.id);
    const general = sales.byZone.find((z) => z.zoneId === s.general.id);
    assert.deepEqual(
      {
        purchases: sales.purchases,
        grossRevenue: cents(sales.grossRevenue),
        capacity: sales.capacity,
        ticketsSold: sales.ticketsSold,
        platea: [platea.sold, platea.revenue],
        general: [general.sold, general.revenue],
        byDay: sales.byDay,
      },
      {
        purchases: s.paid.length,
        grossRevenue: gross,
        capacity: 112,
        ticketsSold: 11,
        platea: [4, '2000.00'],
        general: [7, '1750.00'],
        byDay: [{ date: today, purchases: s.paid.length, revenue: `${gross / 100}.00` }],
      },
    );
    assert.equal(sales.occupancyRate, Number((11 / 112).toFixed(4)));
    assert.equal(
      sales.byZone.reduce((sum, z) => sum + cents(z.revenue), 0),
      cents(sales.grossRevenue),
    );
    const other = await expectContract('GET', path, 403, { token: s.otherOrg.token }, tpl);
    assert.equal(other.code, 'NOT_EVENT_OWNER');
    await expectContract('GET', path, 403, { token: s.buyers[0] }, tpl);
    await expectContract('GET', path, 401, {}, tpl);
    const missing = await expectContract(
      'GET',
      '/events/999999999/sales',
      404,
      { token: s.org.token },
      tpl,
    );
    assert.equal(missing.code, 'EVENT_NOT_FOUND');
    const down = await expectContract(
      'GET',
      path,
      503,
      { token: s.org.token, base: PURCHASE_ISOLATED },
      tpl,
    );
    assert.equal(down.code, 'SERVICE_UNAVAILABLE');
  });

  test('cambiar el precio de una zona después de vender no altera byZone: suma igual a grossRevenue', async () => {
    const path = `/events/${s.event.id}/sales`;
    const tpl = '/events/{eventId}/sales';
    const cents = (m) => Number(m.replace('.', ''));
    const before = await expectContract('GET', path, 200, { token: s.org.token }, tpl);
    await expectContract(
      'PUT',
      `/zones/${s.general.id}`,
      200,
      {
        token: s.org.token,
        body: { name: 'General', type: 'GENERAL', price: '999.00', capacity: 100 },
      },
      '/zones/{zoneId}',
    );
    const after = await expectContract('GET', path, 200, { token: s.org.token }, tpl);
    const general = (sales) => sales.byZone.find((z) => z.zoneId === s.general.id);
    assert.equal(general(after).price, '999.00');
    assert.equal(general(after).revenue, general(before).revenue);
    assert.equal(after.grossRevenue, before.grossRevenue);
    assert.equal(
      after.byZone.reduce((sum, z) => sum + cents(z.revenue), 0),
      cents(after.grossRevenue),
    );
    console.log(
      `[precio cambiado] General ${general(before).price} -> ${general(after).price}; revenue ${general(after).revenue}; grossRevenue ${after.grossRevenue}`,
    );
  });

  const seatStatus = async (seatId) => {
    const map = await expectContract(
      'GET',
      `/zones/${s.platea.id}/seats`,
      200,
      {},
      '/zones/{zoneId}/seats',
    );
    return map.rows[0].seats.find((x) => x.id === seatId).status;
  };
  const requestsTo = (suffix, charge) =>
    fakes.stripe.requests.filter((r) => r.path === `/v1/payment_intents/${charge.id}/${suffix}`)
      .length;
  const refundsOf = (charge) => fakes.stripe.refunds.filter((id) => id === charge.id).length;

  test('captura falla una vez y el reintento la recupera: PAID, 1 cargo neto, asiento SOLD', async () => {
    const token = s.buyers[10];
    const reservation = await reserve(token, [seat(10)]);
    fakes.stripe.captureFailures.set(reservation.id, { mode: '503', times: 1 });
    const failed = await pay(token, reservation.id, 'pm_card_visa', 503);
    assert.equal(failed.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
    const confirmed = await internalReservation(reservation.id);
    assert.equal(confirmed.status, 'CONFIRMED');
    assert.equal(typeof confirmed.purchaseId, 'number');
    const ok = await pay(token, reservation.id, 'pm_card_visa', 201);
    assert.equal(ok.purchase.status, 'PAID');
    assert.equal(ok.purchase.id, confirmed.purchaseId);
    const [charge] = chargesOf(reservation.id);
    assert.equal(netChargesOf(reservation.id).length, 1);
    assert.equal(chargesOf(reservation.id).length, 1);
    assert.equal(
      requestsTo('cancel', charge) + refundsOf(charge),
      0,
      'ni cancelación ni reembolso',
    );
    assert.equal(await seatStatus(s.seats[10]), 'SOLD');
    const again = await pay(token, reservation.id, 'pm_card_visa', 409);
    assert.deepEqual(again.details, { purchaseId: ok.purchase.id });
    console.log(
      `[captura 503 una vez] recuperada por el reintento; capturas=${requestsTo('capture', charge)}`,
    );
  });

  test('el servicio pierde la respuesta de la captura (Stripe sí capturó): el barrido deja la compra PAID sin reembolso', async () => {
    const token = s.buyers[11];
    const reservation = await reserve(token, [seat(11)]);
    fakes.stripe.captureFailures.set(reservation.id, { mode: 'drop', times: 1 });
    await pay(token, reservation.id, 'pm_card_visa', 503);
    const [charge] = chargesOf(reservation.id);
    assert.equal(charge.status, 'succeeded', 'Stripe capturó');
    const isPaid = async () =>
      (await expectContract('GET', '/purchases/me', 200, { token })).items[0]?.status === 'PAID';
    const started = Date.now();
    while (!(await isPaid()) && Date.now() - started < 15000) await sleep(300);
    assert.ok(await isPaid(), 'el barrido concilió a PAID');
    assert.equal(netChargesOf(reservation.id).length, 1);
    assert.equal(requestsTo('cancel', charge) + refundsOf(charge), 0);
    assert.equal(await seatStatus(s.seats[11]), 'SOLD');

    console.log(
      `[captura perdida] PAID por el barrido en ${Date.now() - started} ms, sin reembolso`,
    );
  });

  test('la captura falla siempre: nunca SOLD + reembolso; rechazo definitivo queda CAPTURE_FAILED (502) para revisión', async () => {
    const token = s.buyers[12];
    const reservation = await reserve(token, [seat(12)]);
    fakes.stripe.captureFailures.set(reservation.id, { mode: '503', times: Infinity });
    const first = await pay(token, reservation.id, 'pm_card_visa', 503);
    assert.equal(first.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
    const [charge] = chargesOf(reservation.id);
    assert.ok(
      await waitFor(() => requestsTo('capture', charge) >= 3, 15000),
      'el barrido reintenta',
    );
    assert.equal(charge.status, 'requires_capture');
    assert.equal(requestsTo('cancel', charge) + refundsOf(charge), 0);
    assert.equal(await seatStatus(s.seats[12]), 'SOLD');
    fakes.stripe.captureFailures.set(reservation.id, { mode: '400', times: Infinity });
    const definitive = await pay(token, reservation.id, 'pm_card_visa', 502);
    assert.equal(definitive.code, 'PAYMENT_GATEWAY_ERROR');
    const captures = requestsTo('capture', charge);
    await sleep(6000);
    assert.equal(requestsTo('capture', charge), captures, 'CAPTURE_FAILED ya no se reintenta');
    const after = await pay(token, reservation.id, 'pm_card_visa', 502);
    assert.equal(after.code, 'PAYMENT_GATEWAY_ERROR');
    assert.equal(requestsTo('cancel', charge) + refundsOf(charge), 0, 'nunca se deshace');
    assert.equal(netChargesOf(reservation.id).length, 0);
    assert.equal(await seatStatus(s.seats[12]), 'SOLD');
    const mine = await expectContract('GET', '/purchases/me', 200, { token });
    assert.equal(mine.totalItems, 0);
    fakes.stripe.captureFailures.delete(reservation.id);
    console.log(
      `[captura siempre falla] capturas=${requestsTo('capture', charge)} cancelaciones=0 reembolsos=0 asiento=SOLD compra no PAID`,
    );
  });

  test('400 idempotency_error: el intento queda FAILED, no se reintenta y el siguiente pago usa el intento 2', async () => {
    const token = s.buyers[13];
    const reservation = await reserve(token, [{ zoneId: s.general.id, quantity: 1 }]);
    fakes.stripe.idempotencyErrorFor.add(reservation.id);
    const failed = await pay(token, reservation.id, 'pm_card_visa', 502);
    assert.equal(failed.code, 'PAYMENT_GATEWAY_ERROR');
    fakes.stripe.idempotencyErrorFor.delete(reservation.id);
    const key1 = `tickethub-reservation-${reservation.id}-attempt-1`;
    await sleep(6000);
    assert.equal(
      intentRequestsOf(reservation.id).filter((r) => r.idempotencyKey === key1).length,
      1,
      'el barrido no lo reintentó',
    );
    const ok = await pay(token, reservation.id, 'pm_card_visa', 201);
    assert.equal(ok.purchase.failedAttempts, 0);
    assert.deepEqual(
      intentRequestsOf(reservation.id).map((r) => r.idempotencyKey),
      [key1, `tickethub-reservation-${reservation.id}-attempt-2`],
    );
    assert.equal(netChargesOf(reservation.id).length, 1);
  });

  test('reclamo vencido: la escritura del proceso que lo perdió se rechaza y el rechazo cuenta una sola vez', async () => {
    const token = s.buyers[14];
    const reservation = await reserve(token, [{ zoneId: s.general.id, quantity: 1 }]);
    fakes.stripe.delayMs = 1300;
    let stale;
    try {
      stale = await pay(token, reservation.id, 'pm_card_chargeDeclined', 503, PURCHASE_SHORTCLAIM);
    } finally {
      fakes.stripe.delayMs = 0;
    }
    assert.equal(stale.code, 'PAYMENT_GATEWAY_UNAVAILABLE', 'su escritura fue rechazada');
    const key1 = `tickethub-reservation-${reservation.id}-attempt-1`;
    assert.ok(
      await waitFor(
        () => intentRequestsOf(reservation.id).filter((r) => r.idempotencyKey === key1).length >= 2,
      ),
      'el barrido concilió el intento',
    );
    await sleep(500);
    const ok = await pay(token, reservation.id, 'pm_card_visa', 201);
    assert.equal(ok.purchase.failedAttempts, 1, 'el rechazo se contó una sola vez');
    console.log(
      `[reclamo vencido] respuesta del proceso viejo 503; failedAttempts=${ok.purchase.failedAttempts}`,
    );
  });

  test('boletos: fallas permanentes no acaparan el reintento (lote 2, backoff exponencial)', async () => {
    fakes.tickets.up = false;
    const stuck = [];
    try {
      for (const i of [15, 16, 17]) {
        const r = await reserve(s.buyers[i], [{ zoneId: s.general.id, quantity: 1 }]);
        const result = await pay(s.buyers[i], r.id, 'pm_card_visa', 201);
        assert.equal(result.ticketIssuance, 'PENDING');
        stuck.push(result.purchase.id);
        fakes.tickets.failFor.add(result.purchase.id);
      }
      const r = await reserve(s.buyers[18], [{ zoneId: s.general.id, quantity: 1 }]);
      const late = await pay(s.buyers[18], r.id, 'pm_card_visa', 201);
      assert.equal(late.ticketIssuance, 'PENDING');
      fakes.tickets.up = true;
      const started = Date.now();
      assert.ok(
        await waitFor(() => fakes.tickets.issued.has(late.purchase.id), 20000),
        'la compra nueva se emitió pese a 3 fallas permanentes anteriores',
      );
      const stuckCalls = fakes.tickets.calls.filter((c) => stuck.includes(c.purchaseId)).length;
      console.log(
        `[boletos sin inanición] emitida en ${Date.now() - started} ms; llamadas a compras atascadas=${stuckCalls}`,
      );
    } finally {
      fakes.tickets.up = true;
      for (const id of stuck) fakes.tickets.failFor.delete(id);
    }
  });

  test('GET /internal/stats/sales: totales de compras PAID; sin token 401; no pasa por el gateway', async () => {
    const { res, body } = await call('GET', '/internal/stats/sales', {
      base: PURCHASE,
      headers: internal,
    });
    assert.equal(res.status, 200);
    assertSchema(SALES_STATS_SCHEMA, body, 'SalesStats');
    assert.ok(body.purchases >= s.paid.length);
    const noToken = await call('GET', '/internal/stats/sales', { base: PURCHASE });
    assert.equal(noToken.res.status, 401);
    const viaGateway = await call('GET', '/internal/stats/sales', { headers: internal });
    assert.equal(viaGateway.res.status, 404);
    assert.ok(
      fakes.stripe.requests.every((r) => r.authorization === `Bearer ${STRIPE_KEY}`),
      'nunca se usó otra llave',
    );
  });
});
