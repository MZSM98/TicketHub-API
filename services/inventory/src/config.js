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
  port: Number(process.env.PORT ?? 3003),
  internalToken: required('INTERNAL_TOKEN'),
  internalTimeoutMs: Number(process.env.INTERNAL_TIMEOUT_MS ?? 3000),
  reservationTtlMs: positiveNumber('RESERVATION_TTL_MINUTES', 10) * 60_000,
  maxTicketsPerReservation: positiveNumber('MAX_TICKETS_PER_RESERVATION', 10),
  sweepIntervalMs: positiveNumber('RESERVATION_SWEEP_SECONDS', 60) * 1000,
  services: {
    catalog: process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3002',
  },
};
