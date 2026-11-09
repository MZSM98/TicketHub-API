import { config } from '../config.js';
import {
  PaymentCaptureDeclinedError,
  PaymentIdempotencyError,
  PaymentProviderError,
  PaymentUnavailableError,
} from './errors.js';

export const name = 'stripe';

if (config.paymentProvider === name && config.stripe.secretKey.startsWith('sk_live_')) {
  throw new Error('STRIPE_SECRET_KEY debe ser una llave de modo prueba (sk_test_)');
}

async function send(path, init) {
  let res;
  try {
    res = await fetch(`${config.stripe.apiBase}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${config.stripe.secretKey}`, ...init.headers },
      signal: AbortSignal.timeout(config.stripe.timeoutMs),
    });
  } catch {
    throw new PaymentUnavailableError('Stripe no respondió');
  }
  return res;
}

async function post(path, params, idempotencyKey) {
  const res = await send(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': idempotencyKey,
    },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status >= 500 || res.status === 429) {
    throw new PaymentUnavailableError(`Stripe respondió ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new PaymentProviderError('Respuesta de Stripe inválida');
  }
  if (body === null || typeof body !== 'object') {
    throw new PaymentProviderError('Respuesta de Stripe inválida');
  }
  if (body.error?.type === 'idempotency_error') {
    if (res.status === 409) {
      throw new PaymentUnavailableError('Stripe sigue procesando la solicitud con esta llave');
    }
    throw new PaymentIdempotencyError(
      `Stripe rechazó la llave de idempotencia: ${body.error.message ?? res.status}`,
    );
  }
  return { status: res.status, body };
}

const intentOf = (body) =>
  body?.object === 'payment_intent' && typeof body.id === 'string' ? body : null;

export async function authorize({
  amountCents,
  currency,
  paymentMethodToken,
  idempotencyKey,
  metadata,
}) {
  const params = {
    amount: String(amountCents),
    currency: currency.toLowerCase(),
    payment_method: paymentMethodToken,
    'payment_method_types[]': 'card',
    capture_method: 'manual',
    confirm: 'true',
  };
  for (const [key, value] of Object.entries(metadata)) params[`metadata[${key}]`] = String(value);
  const { status, body } = await post('/v1/payment_intents', params, idempotencyKey);
  const intent = status === 200 ? intentOf(body) : null;
  if (intent) {
    if (intent.status === 'requires_capture' || intent.status === 'succeeded') {
      return { outcome: 'authorized', reference: intent.id };
    }
    return { outcome: 'declined', reference: intent.id, declineCode: intent.status };
  }
  const error = body.error;
  if (status === 402 && error?.type === 'card_error') {
    return {
      outcome: 'declined',
      reference: error.payment_intent?.id ?? null,
      declineCode: error.decline_code ?? error.code ?? 'card_declined',
    };
  }
  if (
    status === 400 &&
    error?.type === 'invalid_request_error' &&
    error.param === 'payment_method'
  ) {
    return {
      outcome: 'declined',
      reference: null,
      declineCode: error.code ?? 'invalid_payment_method',
    };
  }
  throw new PaymentProviderError(`Stripe respondió ${status}`);
}

const unexpectedState = (body) =>
  body.error?.code === 'payment_intent_unexpected_state' ? body.error.payment_intent?.status : null;

const DEFINITIVE_CAPTURE_STATUSES = new Set([400, 402, 404]);
const DEFINITIVE_ERROR_TYPES = new Set(['card_error', 'invalid_request_error']);

export async function capture({ reference, idempotencyKey }) {
  let response;
  try {
    response = await post(`/v1/payment_intents/${reference}/capture`, {}, idempotencyKey);
  } catch (err) {
    if (err instanceof PaymentUnavailableError) throw err;
    throw new PaymentUnavailableError(`Captura sin respuesta definitiva: ${err.message}`);
  }
  const { status, body } = response;
  if (status === 200 && intentOf(body)?.status === 'succeeded') return;
  const state = unexpectedState(body);
  if (state === 'succeeded') return;
  if (state === 'requires_capture') {
    throw new PaymentUnavailableError('Stripe aún reporta la autorización sin capturar');
  }
  if (DEFINITIVE_CAPTURE_STATUSES.has(status) && DEFINITIVE_ERROR_TYPES.has(body.error?.type)) {
    const code = body.error.decline_code ?? body.error.code ?? body.error.type;
    throw new PaymentCaptureDeclinedError(`Stripe rechazó la captura (${status} ${code})`, code);
  }
  throw new PaymentUnavailableError(`Stripe respondió ${status} al capturar`);
}

const LIST_PAGES = 10;

export async function findIntent({ metadata, createdAfter }) {
  let startingAfter = null;
  for (let page = 0; page < LIST_PAGES; page++) {
    const query = new URLSearchParams({ limit: '100', 'created[gte]': String(createdAfter) });
    if (startingAfter) query.set('starting_after', startingAfter);
    const res = await send(`/v1/payment_intents?${query}`, { method: 'GET', headers: {} });
    if (res.status !== 200)
      throw new PaymentUnavailableError(`Stripe respondió ${res.status} al listar`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new PaymentUnavailableError('Respuesta de Stripe inválida al listar');
    }
    if (body?.object !== 'list' || !Array.isArray(body.data)) {
      throw new PaymentUnavailableError('Respuesta de Stripe inválida al listar');
    }
    const match = body.data.find((intent) =>
      Object.entries(metadata).every(([key, value]) => intent.metadata?.[key] === String(value)),
    );
    if (match) return { reference: match.id, status: match.status };
    if (!body.has_more || body.data.length === 0) return null;
    startingAfter = body.data[body.data.length - 1].id;
  }
  throw new PaymentUnavailableError('Demasiados PaymentIntents para buscar el intento');
}

export async function cancel({ reference, idempotencyKey }) {
  const { status, body } = await post(
    `/v1/payment_intents/${reference}/cancel`,
    {},
    idempotencyKey,
  );
  if (status === 200 && intentOf(body)?.status === 'canceled') return 'canceled';
  if (status === 404 && body.error?.code === 'resource_missing') return 'missing';
  const state = unexpectedState(body);
  if (state === 'canceled') return 'canceled';
  if (state === 'succeeded') return 'captured';
  throw new PaymentProviderError(`Stripe respondió ${status} al cancelar`);
}

export async function refund({ reference, idempotencyKey }) {
  const { status, body } = await post('/v1/refunds', { payment_intent: reference }, idempotencyKey);
  if (status !== 200 || body.object !== 'refund') {
    throw new PaymentProviderError(`Stripe respondió ${status} al reembolsar`);
  }
}
