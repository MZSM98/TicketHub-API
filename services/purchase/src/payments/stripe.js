import { config } from '../config.js';
import {
  PaymentIdempotencyError,
  PaymentProviderError,
  PaymentUnavailableError,
} from './errors.js';

export const name = 'stripe';

if (config.paymentProvider === name && config.stripe.secretKey.startsWith('sk_live_')) {
  throw new Error('STRIPE_SECRET_KEY debe ser una llave de modo prueba (sk_test_)');
}

async function post(path, params, idempotencyKey) {
  let res;
  try {
    res = await fetch(`${config.stripe.apiBase}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.stripe.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': idempotencyKey,
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(config.stripe.timeoutMs),
    });
  } catch {
    throw new PaymentUnavailableError('Stripe no respondió');
  }
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

export async function capture({ reference, idempotencyKey }) {
  const { status, body } = await post(
    `/v1/payment_intents/${reference}/capture`,
    {},
    idempotencyKey,
  );
  if (status === 200 && intentOf(body)?.status === 'succeeded') return;
  if (unexpectedState(body) === 'succeeded') return;
  throw new PaymentProviderError(`Stripe respondió ${status} al capturar`);
}

export async function cancel({ reference, idempotencyKey }) {
  const { status, body } = await post(
    `/v1/payment_intents/${reference}/cancel`,
    {},
    idempotencyKey,
  );
  if (status === 200 && intentOf(body)?.status === 'canceled') return 'canceled';
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
