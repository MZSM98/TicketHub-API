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

export const MAX_TICKETS_LIMIT = 10;

function ticketsPerReservation(name) {
  const raw = process.env[name] || String(MAX_TICKETS_LIMIT);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > MAX_TICKETS_LIMIT) {
    throw new Error(`${name} debe ser un entero entre 1 y ${MAX_TICKETS_LIMIT}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3003),
  internalToken: required('INTERNAL_TOKEN'),
  internalTimeoutMs: Number(process.env.INTERNAL_TIMEOUT_MS ?? 3000),
  reservationTtlMs: positiveNumber('RESERVATION_TTL_MINUTES', 10) * 60_000,
  maxTicketsPerReservation: ticketsPerReservation('MAX_TICKETS_PER_RESERVATION'),
  sweepIntervalMs: positiveNumber('RESERVATION_SWEEP_SECONDS', 60) * 1000,
  services: {
    catalog: process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3002',
  },
};
