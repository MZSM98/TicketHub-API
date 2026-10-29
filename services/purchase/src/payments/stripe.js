import { config } from '../config.js';
import { PaymentProviderError, PaymentUnavailableError } from './errors.js';

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
  return { status: res.status, body };
}

export async function charge({
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
    confirm: 'true',
  };
  for (const [key, value] of Object.entries(metadata)) params[`metadata[${key}]`] = String(value);
  const { status, body } = await post('/v1/payment_intents', params, idempotencyKey);
  if (status === 200 && body.object === 'payment_intent' && typeof body.id === 'string') {
    if (body.status === 'succeeded') return { approved: true, reference: body.id };
    await post(`/v1/payment_intents/${body.id}/cancel`, {}, `${idempotencyKey}-cancel`).catch(
      () => null,
    );
    return { approved: false, reference: body.id, declineCode: body.status };
  }
  const error = body.error;
  if (status === 402 && error?.type === 'card_error') {
    return {
      approved: false,
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
      approved: false,
      reference: null,
      declineCode: error.code ?? 'invalid_payment_method',
    };
  }
  throw new PaymentProviderError(`Stripe respondió ${status}`);
}

export async function refund({ reference, idempotencyKey }) {
  const { status, body } = await post('/v1/refunds', { payment_intent: reference }, idempotencyKey);
  if (status !== 200 || body.object !== 'refund') {
    throw new PaymentProviderError(`Stripe respondió ${status} al reembolsar`);
  }
}
