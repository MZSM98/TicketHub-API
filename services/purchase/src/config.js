function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} no es un número válido`);
  return value;
}

function atLeastOne(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} debe ser un entero mayor o igual a 1`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3004),
  internalToken: required('INTERNAL_TOKEN'),
  internalTimeoutMs: positiveNumber('INTERNAL_TIMEOUT_MS', 3000),
  paymentProvider: process.env.PAYMENT_PROVIDER ?? 'stripe',
  paymentMaxAttempts: atLeastOne('PAYMENT_MAX_ATTEMPTS', 3),
  ticketRetryMs: positiveNumber('TICKET_RETRY_SECONDS', 30) * 1000,
  paymentSweepMs: positiveNumber('PAYMENT_SWEEP_SECONDS', 60) * 1000,
  reconcileAfterSeconds: positiveNumber('PAYMENT_RECONCILE_AFTER_SECONDS', 60),
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    apiBase: process.env.STRIPE_API_BASE ?? 'https://api.stripe.com',
    timeoutMs: positiveNumber('STRIPE_TIMEOUT_MS', 10000),
  },
  services: {
    catalog: process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3002',
    inventory: process.env.INVENTORY_SERVICE_URL ?? 'http://inventory-service:3003',
    ticket: process.env.TICKET_SERVICE_URL ?? 'http://ticket-service:3005',
  },
};

config.claimSeconds =
  Math.ceil((3 * config.stripe.timeoutMs + 3 * config.internalTimeoutMs) / 1000) + 5;
