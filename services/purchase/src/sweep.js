import { query } from '@tickethub/common/db';
import {
  captureOrMarkFailed,
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

async function reconcilePending(claim, attempt, userId) {
  const result = await sendAuthorization(claim, attempt, userId);
  const recorded = await recordAuthorization(claim, attempt, result);
  if (recorded.authorized) return undoAttempt(claim, recorded.attempt);
  if (recorded.failedAttempts >= config.paymentMaxAttempts) {
    await releaseReservation(attempt.reservation_id).catch(() => false);
  }
}

async function reconcileAuthorized(claim, attempt) {
  const reservation = await getReservation(attempt.reservation_id);
  if (reservation?.status === 'CONFIRMED' && reservation.purchaseId === attempt.purchase_id) {
    await captureOrMarkFailed(claim, attempt);
    await completePurchase(claim, attempt, reservation.items);
    await issueFor(attempt.purchase_id);
    return;
  }
  return undoAttempt(claim, attempt);
}

async function reconcile(row) {
  const claim = await claimPurchase(row.purchase_id);
  if (!claim) return;
  try {
    const attempt = await findAttempt(row.id);
    if (attempt.status === 'PENDING') return await reconcilePending(claim, attempt, row.user_id);
    if (attempt.status === 'AUTHORIZED') return await reconcileAuthorized(claim, attempt);
    if (attempt.status === 'CANCEL_PENDING' || attempt.status === 'REFUND_PENDING') {
      return await undoAttempt(claim, attempt);
    }
  } finally {
    await releaseClaim(claim).catch(() => null);
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
        ORDER BY a.updated_at LIMIT 50`,
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
