import { config } from '../config.js';
import * as stripe from './stripe.js';

export { PaymentProviderError, PaymentUnavailableError } from './errors.js';

const PROVIDERS = { stripe };

const provider = PROVIDERS[config.paymentProvider];
if (!provider) throw new Error(`PAYMENT_PROVIDER no soportado: ${config.paymentProvider}`);

export const providerName = provider.name;
export const charge = (request) => provider.charge(request);
export const refund = (request) => provider.refund(request);
