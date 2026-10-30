import { config } from '../config.js';
import * as stripe from './stripe.js';

export {
  PaymentCaptureDeclinedError,
  PaymentIdempotencyError,
  PaymentProviderError,
  PaymentUnavailableError,
} from './errors.js';

const PROVIDERS = { stripe };

const provider = PROVIDERS[config.paymentProvider];
if (!provider) throw new Error(`PAYMENT_PROVIDER no soportado: ${config.paymentProvider}`);

export const providerName = provider.name;
export const authorize = (request) => provider.authorize(request);
export const capture = (request) => provider.capture(request);
export const cancel = (request) => provider.cancel(request);
export const refund = (request) => provider.refund(request);
