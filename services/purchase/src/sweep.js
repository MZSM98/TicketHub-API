import { query } from '@tickethub/common/db';
import {
  captureAttempt,
  claimPurchase,
  completePurchase,
  findAttempt,
  recordAuthorization,
  releaseClaim,
  sendAuthorization,
  undoAttempt,
} from './attempts.js';
import { config } from './config.js';
import { getReservation, releaseReservation } from './services.js';
import { issueFor } from './tickets.js';

async function reconcilePending(attempt, userId) {
  const result = await sendAuthorization(attempt, userId);
  const recorded = await recordAuthorization(attempt, result);
  if (recorded.authorized) return undoAttempt(recorded.attempt);
  if (recorded.failedAttempts >= config.paymentMaxAttempts) {
    await releaseReservation(attempt.reservation_id).catch(() => false);
  }
}

async function reconcileAuthorized(attempt) {
  const reservation = await getReservation(attempt.reservation_id);
  if (!reservation) return undoAttempt(attempt);
  if (reservation.status === 'CONFIRMED' && reservation.purchaseId === attempt.purchase_id) {
    await captureAttempt(attempt);
    await completePurchase(attempt, reservation.items);
    await issueFor(attempt.purchase_id);
    return;
  }
  return undoAttempt(attempt);
}

async function reconcile(row) {
  const claim = await claimPurchase(row.purchase_id);
  if (!claim && (row.status === 'PENDING' || row.status === 'AUTHORIZED')) return;
  try {
    const attempt = await findAttempt(row.id);
    if (attempt.status === 'PENDING') return await reconcilePending(attempt, row.user_id);
    if (attempt.status === 'AUTHORIZED') return await reconcileAuthorized(attempt);
    if (attempt.status === 'CANCEL_PENDING' || attempt.status === 'REFUND_PENDING') {
      return await undoAttempt(attempt);
    }
  } finally {
    if (claim) await releaseClaim(claim).catch(() => null);
  }
}

let sweeping = false;
export async function sweepPayments() {
  if (sweeping) return;
  sweeping = true;
  try {
    const rows = await query(
      `SELECT a.id, a.purchase_id, a.status, p.user_id
         FROM payment_attempts a JOIN purchases p ON p.id = a.purchase_id
        WHERE a.status IN ('PENDING', 'AUTHORIZED', 'CANCEL_PENDING', 'REFUND_PENDING')
          AND a.updated_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)
        ORDER BY a.id LIMIT 50`,
      [config.reconcileAfterSeconds],
    );
    for (const row of rows) {
      try {
        await reconcile(row);
      } catch (err) {
        console.error(`Conciliación del intento ${row.id} falló: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`Conciliación de pagos falló: ${err.message}`);
  } finally {
    sweeping = false;
  }
}

export function startPaymentSweep() {
  if (config.paymentSweepMs <= 0) return null;
  return setInterval(sweepPayments, config.paymentSweepMs);
}
