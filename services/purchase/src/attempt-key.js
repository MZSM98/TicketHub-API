const NAMESPACE = /^[a-z0-9-]{1,40}$/;
const PREFIX = 'tickethub-';

export const buildAttemptKey = (namespace, reservationId, attempt) =>
  `${PREFIX}${namespace}-reservation-${reservationId}-attempt-${attempt}`;

export function keyNamespace({ idempotency_key: key, reservation_id, attempt }) {
  const suffix = `-reservation-${reservation_id}-attempt-${attempt}`;
  if (!key.startsWith(PREFIX) || !key.endsWith(suffix)) return null;
  const namespace = key.slice(PREFIX.length, key.length - suffix.length);
  return NAMESPACE.test(namespace) ? namespace : null;
}
