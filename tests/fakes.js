import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { INVENTORY, PURCHASE } from './helpers.js';

const INVENTORY_ORIGIN = new URL(INVENTORY).origin;
const PURCHASE_ORIGIN = new URL(PURCHASE).origin;
export const STRIPE_KEY = 'sk_test_fake_tickethub';

export const fakes = {
  inventoryUp: true,
  salesUp: true,
  tokens: [],
  deletedZones: [],
  tickets: { up: true, failFor: new Set(), calls: [], issued: new Map() },
  stripe: {
    mode: 'normal',
    delayMs: 0,
    failCancels: false,
    idempotencyErrorFor: new Set(),
    captureFailures: new Map(),
    requests: [],
    charges: [],
    intents: new Map(),
    refunds: [],
    replays: 0,
    idempotency: new Map(),
  },
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function proxy(origin, req, res, url) {
  const upstream = await fetch(`${origin}${url.pathname}${url.search}`, {
    method: req.method,
    headers: { 'x-internal-token': req.headers['x-internal-token'] },
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, text ? { 'content-type': 'application/json' } : {});
  res.end(text);
  return upstream.status;
}

const DECLINES = {
  pm_card_chargeDeclined: 'generic_decline',
  pm_card_insufficientFunds: 'insufficient_funds',
};

const APPROVED = new Set(['pm_card_visa', 'pm_delay3000']);
export const SLOW_METHODS = { pm_delay3000: 3000 };

function paymentIntent(params) {
  const id = `pi_fake_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const manual = params.get('capture_method') === 'manual';
  const record = {
    id,
    amount: Number(params.get('amount')),
    currency: params.get('currency'),
    paymentMethod: params.get('payment_method'),
    reservationId: Number(params.get('metadata[reservation_id]')),
    attempt: Number(params.get('metadata[attempt]')),
    status: manual ? 'requires_capture' : 'succeeded',
    refunded: false,
  };
  if (APPROVED.has(params.get('payment_method'))) {
    fakes.stripe.charges.push(record);
    fakes.stripe.intents.set(id, record);
    return [200, { id, object: 'payment_intent', status: record.status, amount: record.amount }];
  }
  const declineCode = DECLINES[params.get('payment_method')];
  if (declineCode) {
    return [
      402,
      {
        error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: declineCode,
          message: 'Your card was declined.',
          payment_intent: { id, object: 'payment_intent', status: 'requires_payment_method' },
        },
      },
    ];
  }
  return [
    400,
    {
      error: {
        type: 'invalid_request_error',
        code: 'resource_missing',
        param: 'payment_method',
        message: 'No such PaymentMethod',
      },
    },
  ];
}

function unexpectedState(intent) {
  return [
    400,
    {
      error: {
        type: 'invalid_request_error',
        code: 'payment_intent_unexpected_state',
        payment_intent: { id: intent.id, object: 'payment_intent', status: intent.status },
      },
    },
  ];
}

function intentAction(id, action) {
  const intent = fakes.stripe.intents.get(id) ?? { id, status: 'requires_payment_method' };
  if (action === 'capture') {
    if (intent.status !== 'requires_capture') return unexpectedState(intent);
    intent.status = 'succeeded';
  } else {
    if (intent.status === 'succeeded' || intent.status === 'canceled')
      return unexpectedState(intent);
    intent.status = 'canceled';
  }
  return [200, { id, object: 'payment_intent', status: intent.status }];
}

function stripeRoute(path, params) {
  if (path === '/v1/payment_intents') return paymentIntent(params);
  if (path === '/v1/refunds') {
    const refund = {
      id: `re_fake_${randomUUID().slice(0, 8)}`,
      object: 'refund',
      status: 'succeeded',
    };
    fakes.stripe.refunds.push(params.get('payment_intent'));
    const intent = fakes.stripe.intents.get(params.get('payment_intent'));
    if (intent) intent.refunded = true;
    return [200, { ...refund, payment_intent: params.get('payment_intent') }];
  }
  const action = /^\/v1\/payment_intents\/([^/]+)\/(cancel|capture)$/.exec(path);
  if (action) return intentAction(action[1], action[2]);
  return [404, { error: { type: 'invalid_request_error', message: 'Unrecognized request URL' } }];
}

async function handleStripe(req, res, url) {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const stripe = fakes.stripe;
  stripe.requests.push({
    path: url.pathname,
    authorization: req.headers.authorization,
    contentType: req.headers['content-type'],
    idempotencyKey: req.headers['idempotency-key'],
    params: Object.fromEntries(params),
  });
  if (req.headers.authorization !== `Bearer ${STRIPE_KEY}`) {
    return send(res, 401, { error: { type: 'invalid_request_error', message: 'Invalid API Key' } });
  }
  if (stripe.mode === 'down') return send(res, 503, { error: { type: 'api_error' } });
  if (stripe.failCancels && /\/(cancel|refunds)$/.test(url.pathname)) {
    return send(res, 503, { error: { type: 'api_error' } });
  }
  if (stripe.mode === 'garbage') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html>proxy error</html>');
  }
  const key = req.headers['idempotency-key'];
  const reservationId = Number(params.get('metadata[reservation_id]'));
  if (url.pathname === '/v1/payment_intents' && stripe.idempotencyErrorFor.has(reservationId)) {
    return send(res, 400, {
      error: {
        type: 'idempotency_error',
        message: 'Keys for idempotent requests can only be used with the same parameters',
      },
    });
  }
  const captured = /^\/v1\/payment_intents\/([^/]+)\/capture$/.exec(url.pathname);
  const failure = captured
    ? stripe.captureFailures.get(stripe.intents.get(captured[1])?.reservationId)
    : null;
  if (failure && failure.times > 0 && failure.mode !== 'drop') {
    failure.times--;
    if (failure.mode === '503') return send(res, 503, { error: { type: 'api_error' } });
    return send(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: 'charge_expired_for_capture',
        message: 'The charge has expired and can no longer be captured.',
      },
    });
  }
  const seen = key ? stripe.idempotency.get(key) : undefined;
  if (seen?.inFlight) {
    stripe.inUse = (stripe.inUse ?? 0) + 1;
    return send(res, 409, {
      error: {
        type: 'idempotency_error',
        code: 'idempotency_key_in_use',
        message: 'There is currently another in-progress request using this Idempotent Key',
      },
    });
  }
  let status;
  let body;
  if (seen && seen.raw !== raw) {
    [status, body] = [
      400,
      {
        error: {
          type: 'idempotency_error',
          message: 'Keys for idempotent requests can only be used with the same parameters',
        },
      },
    ];
  } else if (seen) {
    stripe.replays++;
    [status, body] = [seen.status, seen.body];
  } else {
    [status, body] = stripeRoute(url.pathname, params);
    if (key) stripe.idempotency.set(key, { raw, status, body, inFlight: true });
  }
  const delay = stripe.delayMs + (seen ? 0 : (SLOW_METHODS[params.get('payment_method')] ?? 0));
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const stored = key ? stripe.idempotency.get(key) : undefined;
  if (stored) stored.inFlight = false;
  if (failure && failure.mode === 'drop' && failure.times > 0) {
    failure.times--;
    return res.destroy();
  }
  if (res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(seen ? { 'idempotent-replayed': 'true' } : {}),
  });
  res.end(JSON.stringify(body));
}

async function handleTickets(req, res) {
  const payload = JSON.parse(await readBody(req));
  fakes.tickets.calls.push(payload);
  if (!fakes.tickets.up || fakes.tickets.failFor.has(payload.purchaseId)) {
    return send(res, 500, {
      code: 'QR_GENERATION_FAILED',
      message: 'Error al generar el boleto digital',
    });
  }
  const existing = fakes.tickets.issued.get(payload.purchaseId);
  if (existing) return send(res, 200, { purchaseId: payload.purchaseId, ticketIds: existing });
  const places = payload.items.reduce((sum, item) => sum + item.quantity, 0);
  const ticketIds = Array.from({ length: places }, () => randomUUID());
  fakes.tickets.issued.set(payload.purchaseId, ticketIds);
  return send(res, 201, { purchaseId: payload.purchaseId, ticketIds });
}

export function startFakes(port, internalToken) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fakes');
    if (url.pathname.startsWith('/v1/')) return handleStripe(req, res, url);
    fakes.tokens.push(req.headers['x-internal-token']);
    if (req.headers['x-internal-token'] !== internalToken) {
      return send(res, 401, { code: 'UNAUTHORIZED', message: 'Token interno inválido' });
    }
    const zonesOfEvent = /^\/api\/v1\/internal\/events\/(\d+)\/zones$/.exec(url.pathname);
    if ((req.method === 'DELETE' && zonesOfEvent) || url.pathname === '/api/v1/internal/zones') {
      if (!fakes.inventoryUp) return send(res, 500, { code: 'INTERNAL_ERROR', message: 'x' });
      const status = await proxy(INVENTORY_ORIGIN, req, res, url);
      if (zonesOfEvent && status === 204) fakes.deletedZones.push(Number(zonesOfEvent[1]));
      return;
    }
    if (url.pathname === '/api/v1/internal/stats/sales') {
      if (!fakes.salesUp) return send(res, 503, { code: 'SERVICE_UNAVAILABLE', message: 'x' });
      return proxy(PURCHASE_ORIGIN, req, res, url);
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/internal/tickets/issue') {
      return handleTickets(req, res);
    }
    return send(res, 404, { code: 'NOT_FOUND', message: 'Recurso no encontrado' });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
