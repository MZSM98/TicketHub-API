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

export const config = {
  port: Number(process.env.PORT ?? 3004),
  internalToken: required('INTERNAL_TOKEN'),
  internalTimeoutMs: positiveNumber('INTERNAL_TIMEOUT_MS', 3000),
  paymentProvider: process.env.PAYMENT_PROVIDER ?? 'stripe',
  paymentMaxAttempts: positiveNumber('PAYMENT_MAX_ATTEMPTS', 3),
  ticketRetryMs: positiveNumber('TICKET_RETRY_SECONDS', 30) * 1000,
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
