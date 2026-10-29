import { query } from '@tickethub/common/db';
import { forbidden, HttpError, serviceUnavailable } from '@tickethub/common/http';
import { config } from './config.js';
import {
  captureOrMarkFailed,
  ClaimLostError,
  claimPurchase,
  completePurchase,
  createAttempt,
  latestAttempt,
  openAttempt,
  recordAuthorization,
  releaseClaim,
  sendAuthorization,
  undoAttempt,
} from './attempts.js';
import { PaymentProviderError, PaymentUnavailableError, providerName } from './payments/index.js';
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

export async function findByReservation(reservationId) {
  const [row] = await query(`SELECT ${PURCHASE_COLUMNS} FROM purchases WHERE reservation_id = ?`, [
    reservationId,
  ]);
  return row ?? null;
}

async function exhausted(reservationId) {
  const released = await releaseReservation(reservationId).catch(() => false);
  if (!released) console.error(`No se pudo liberar la reserva ${reservationId}; se reintentará`);
  return attemptsExhausted();
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
    if (row && row.status !== 'PAID' && reservation.purchaseId === row.id) return reservation;
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function purchaseById(id) {
  const [row] = await query(`SELECT ${PURCHASE_COLUMNS} FROM purchases WHERE id = ?`, [id]);
  return row;
}

async function ensurePurchaseRow(userId, reservation) {
  await query(
    `INSERT INTO purchases (reservation_id, user_id, event_id, total, currency, payment_provider, status, failed_attempts)
     VALUES (?, ?, ?, ?, ?, ?, 'DECLINED', 0)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      reservation.id,
      userId,
      reservation.eventId,
      reservation.total,
      reservation.currency,
      providerName,
    ],
  );
  return findByReservation(reservation.id);
}

async function waitForClaim(purchaseId) {
  const deadline = Date.now() + (config.claimSeconds + 2) * 1000;
  while (Date.now() < deadline) {
    const claim = await claimPurchase(purchaseId);
    if (claim) return claim;
    const row = await purchaseById(purchaseId);
    if (row.status === 'PAID') throw alreadyPaid(row.id);
    await sleep(100);
  }
  throw serviceUnavailable();
}

function providerFailure(err) {
  if (err instanceof PaymentUnavailableError) return gatewayUnavailable();
  if (err instanceof PaymentProviderError) return gatewayError();
  return err;
}

async function authorizeAttempt(claim, attempt, userId) {
  let result;
  try {
    result = await sendAuthorization(claim, attempt, userId);
  } catch (err) {
    throw providerFailure(err);
  }
  const recorded = await recordAuthorization(claim, attempt, result);
  if (recorded.authorized) return recorded.attempt;
  if (recorded.failedAttempts >= config.paymentMaxAttempts) {
    throw await exhausted(attempt.reservation_id);
  }
  return {
    declined: declined(config.paymentMaxAttempts - recorded.failedAttempts, recorded.declineCode),
  };
}

async function finalize(claim, attempt, reservation) {
  const sale = await confirmSale(attempt.reservation_id, attempt.purchase_id).catch(() => ({
    status: 503,
  }));
  if (sale.status === 409 || sale.status === 410) {
    await undoAttempt(claim, attempt);
    throw saleFailure(sale.status);
  }
  if (sale.status !== 200) throw serviceUnavailable();
  try {
    await captureOrMarkFailed(claim, attempt);
  } catch (err) {
    throw providerFailure(err);
  }
  await completePurchase(claim, attempt, reservation.items);
}

async function finishConfirmedSale(claim, reservation) {
  const attempt = await latestAttempt(claim.purchaseId);
  if (attempt?.status === 'AUTHORIZED') return finalize(claim, attempt, reservation);
  if (attempt?.status === 'CAPTURE_FAILED') throw gatewayError();
  throw serviceUnavailable();
}

async function runClaimed(claim, userId, reservation, paymentMethodToken) {
  const { purchaseId } = claim;
  if (reservation.status === 'CONFIRMED') return finishConfirmedSale(claim, reservation);
  let open = await openAttempt(purchaseId);
  if (open?.status === 'PENDING') {
    const outcome = await authorizeAttempt(claim, open, userId);
    if (outcome.declined) open = null;
    else open = outcome;
  }
  if (open) return finalize(claim, open, reservation);
  const row = await purchaseById(purchaseId);
  if (row.failed_attempts >= config.paymentMaxAttempts) {
    throw await exhausted(row.reservation_id);
  }
  const attempt = await createAttempt(claim, row, paymentMethodToken, toCents(row.total));
  const outcome = await authorizeAttempt(claim, attempt, userId);
  if (outcome.declined) throw outcome.declined;
  return finalize(claim, outcome, reservation);
}

export async function processPurchase(userId, { reservationId, paymentMethodToken }) {
  const reservation = await preflight(userId, reservationId);
  const row = await ensurePurchaseRow(userId, reservation);
  if (row.status === 'PAID') throw alreadyPaid(row.id);
  const claim = await waitForClaim(row.id);
  try {
    const current = await purchaseById(row.id);
    if (current.status === 'PAID') throw alreadyPaid(current.id);
    await runClaimed(claim, userId, reservation, paymentMethodToken);
  } catch (err) {
    if (err instanceof ClaimLostError) {
      console.error(`Compra ${row.id}: ${err.message}; no se guardó el resultado`);
      throw gatewayUnavailable();
    }
    throw err;
  } finally {
    await releaseClaim(claim).catch(() => null);
  }
  const purchase = toPurchase(await purchaseById(row.id));
  return { purchase, ...(await issueFor(purchase.id)) };
}
