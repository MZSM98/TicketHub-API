import { createHash } from 'node:crypto';
import { query, transaction } from '@tickethub/common/db';
import { forbidden, HttpError, serviceUnavailable } from '@tickethub/common/http';
import { config } from './config.js';
import {
  charge,
  PaymentProviderError,
  PaymentUnavailableError,
  providerName,
  refund,
} from './payments/index.js';
import { confirmSale, getReservation, releaseReservation } from './services.js';
import { issueFor } from './tickets.js';

export const purchaseNotFound = () =>
  new HttpError(404, 'PURCHASE_NOT_FOUND', 'La compra no existe');
const reservationNotFound = () =>
  new HttpError(404, 'RESERVATION_NOT_FOUND', 'La reserva no existe');
const reservationExpired = () => new HttpError(410, 'RESERVATION_EXPIRED', 'Tiempo agotado');
const reservationNotActive = () =>
  new HttpError(409, 'RESERVATION_NOT_ACTIVE', 'La reserva ya no está activa');
const alreadyPaid = (purchaseId) =>
  new HttpError(409, 'RESERVATION_ALREADY_PAID', 'Esta reserva ya fue pagada', { purchaseId });
const attemptsExhausted = () =>
  new HttpError(
    402,
    'PAYMENT_ATTEMPTS_EXHAUSTED',
    'Pago declinado. Se agotaron los intentos y los asientos fueron liberados',
    { attemptsRemaining: 0 },
  );
const declined = (attemptsRemaining, providerDeclineCode) =>
  new HttpError(402, 'PAYMENT_DECLINED', 'Pago declinado', {
    attemptsRemaining,
    providerDeclineCode,
  });
const gatewayUnavailable = () =>
  new HttpError(503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Pasarela no disponible');
const gatewayError = () => new HttpError(502, 'PAYMENT_GATEWAY_ERROR', 'Pasarela no disponible');

export const PURCHASE_COLUMNS =
  'id, reservation_id, user_id, event_id, total, currency, payment_provider, payment_reference, status, failed_attempts, created_at';

const iso = (date) => date.toISOString().replace('.000Z', 'Z');

export const toPurchase = (row) => ({
  id: row.id,
  reservationId: row.reservation_id,
  userId: row.user_id,
  eventId: row.event_id,
  total: row.total,
  currency: row.currency,
  paymentProvider: row.payment_provider,
  paymentReference: row.payment_reference,
  status: row.status,
  failedAttempts: row.failed_attempts,
  createdAt: iso(row.created_at),
});

const toCents = (money) => Number(money.replace('.', ''));

export async function findByReservation(reservationId, conn) {
  const [row] = await query(
    `SELECT ${PURCHASE_COLUMNS} FROM purchases WHERE reservation_id = ?${conn ? ' FOR UPDATE' : ''}`,
    [reservationId],
    conn,
  );
  return row ?? null;
}

const isLockFailure = (err) => err?.errno === 1213 || err?.errno === 1205;

async function withRetry(work) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (!isLockFailure(err) || attempt >= 3) throw err;
    }
  }
}

function idempotencyKey(reservationId, attempt, paymentMethodToken) {
  const token = createHash('sha256').update(paymentMethodToken).digest('hex').slice(0, 16);
  return `tickethub-reservation-${reservationId}-attempt-${attempt}-${token}`;
}

async function exhausted(reservationId) {
  const released = await releaseReservation(reservationId).catch(() => false);
  if (!released) console.error(`No se pudo liberar la reserva ${reservationId}; se reintentará`);
  return attemptsExhausted();
}

async function undoCharge(reference, key) {
  try {
    await refund({ reference, idempotencyKey: `${key}-refund` });
  } catch (err) {
    console.error(`No se pudo reembolsar ${reference}: ${err.message}`);
  }
}

function saleFailure(status) {
  if (status === 410) return reservationExpired();
  if (status === 409) return reservationNotActive();
  return serviceUnavailable();
}

async function preflight(userId, reservationId) {
  const reservation = await getReservation(reservationId);
  if (!reservation) throw reservationNotFound();
  if (reservation.userId !== userId) throw forbidden();
  if (reservation.status === 'CONFIRMED') {
    const row = await findByReservation(reservationId);
    throw alreadyPaid(row?.id ?? reservation.purchaseId);
  }
  if (reservation.status === 'EXPIRED') throw reservationExpired();
  if (reservation.status !== 'ACTIVE') {
    const row = await findByReservation(reservationId);
    if (row && row.failed_attempts >= config.paymentMaxAttempts) throw attemptsExhausted();
    throw reservationNotActive();
  }
  return reservation;
}

export async function processPurchase(userId, { reservationId, paymentMethodToken }) {
  const reservation = await preflight(userId, reservationId);
  const outcome = await withRetry(() =>
    transaction(async (conn) => {
      await query(
        `INSERT INTO purchases (reservation_id, user_id, event_id, total, currency, payment_provider, status, failed_attempts)
         VALUES (?, ?, ?, ?, ?, ?, 'DECLINED', 0)
         ON DUPLICATE KEY UPDATE id = id`,
        [
          reservationId,
          userId,
          reservation.eventId,
          reservation.total,
          reservation.currency,
          providerName,
        ],
        conn,
      );
      const row = await findByReservation(reservationId, conn);
      if (row.status === 'PAID') return { error: alreadyPaid(row.id) };
      if (row.failed_attempts >= config.paymentMaxAttempts) {
        return { error: await exhausted(reservationId) };
      }
      const attempt = row.failed_attempts + 1;
      const key = idempotencyKey(reservationId, attempt, paymentMethodToken);
      let result;
      try {
        result = await charge({
          amountCents: toCents(row.total),
          currency: row.currency,
          paymentMethodToken,
          idempotencyKey: key,
          metadata: { reservation_id: reservationId, purchase_id: row.id, user_id: userId },
        });
      } catch (err) {
        if (err instanceof PaymentUnavailableError) throw gatewayUnavailable();
        if (err instanceof PaymentProviderError) throw gatewayError();
        throw err;
      }
      if (!result.approved) {
        await query(
          `UPDATE purchases SET status = 'DECLINED', failed_attempts = ?, payment_provider = ?,
             payment_reference = COALESCE(?, payment_reference) WHERE id = ?`,
          [attempt, providerName, result.reference, row.id],
          conn,
        );
        if (attempt >= config.paymentMaxAttempts) return { error: await exhausted(reservationId) };
        return { error: declined(config.paymentMaxAttempts - attempt, result.declineCode) };
      }
      const sale = await confirmSale(reservationId, row.id).catch(() => ({ status: 503 }));
      if (sale.status !== 200) {
        await undoCharge(result.reference, key);
        throw saleFailure(sale.status);
      }
      await query(
        "UPDATE purchases SET status = 'PAID', payment_provider = ?, payment_reference = ? WHERE id = ?",
        [providerName, result.reference, row.id],
        conn,
      );
      return { purchaseId: row.id };
    }),
  );
  if (outcome.error) throw outcome.error;
  const [row] = await query(`SELECT ${PURCHASE_COLUMNS} FROM purchases WHERE id = ?`, [
    outcome.purchaseId,
  ]);
  const purchase = toPurchase(row);
  return { purchase, ...(await issueFor(purchase, reservation)) };
}
