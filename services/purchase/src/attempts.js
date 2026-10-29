import { randomUUID } from 'node:crypto';
import { query, transaction } from '@tickethub/common/db';
import { config } from './config.js';
import { authorize, cancel, capture, providerName, refund } from './payments/index.js';

export const OPEN_STATUSES = ['PENDING', 'AUTHORIZED'];

export const attemptKey = (reservationId, attempt) =>
  `tickethub-reservation-${reservationId}-attempt-${attempt}`;

export async function claimPurchase(purchaseId) {
  const token = randomUUID();
  const result = await query(
    `UPDATE purchases SET claim_token = ?, claimed_until = DATE_ADD(NOW(3), INTERVAL ? SECOND)
      WHERE id = ? AND status <> 'PAID' AND (claimed_until IS NULL OR claimed_until < NOW(3))`,
    [token, config.claimSeconds, purchaseId],
  );
  return result.affectedRows === 1 ? { purchaseId, token } : null;
}

export async function releaseClaim(claim) {
  await query(
    'UPDATE purchases SET claim_token = NULL, claimed_until = NULL WHERE id = ? AND claim_token = ?',
    [claim.purchaseId, claim.token],
  );
}

export async function findAttempt(id) {
  const [row] = await query('SELECT * FROM payment_attempts WHERE id = ?', [id]);
  return row;
}

export async function openAttempt(purchaseId) {
  const [row] = await query(
    `SELECT * FROM payment_attempts WHERE purchase_id = ? AND status IN ('PENDING', 'AUTHORIZED')
      ORDER BY attempt DESC LIMIT 1`,
    [purchaseId],
  );
  return row ?? null;
}

export async function createAttempt(purchase, paymentMethodToken, amountCents) {
  const [{ last }] = await query(
    'SELECT COALESCE(MAX(attempt), 0) AS last FROM payment_attempts WHERE purchase_id = ?',
    [purchase.id],
  );
  const attempt = Number(last) + 1;
  const result = await query(
    `INSERT INTO payment_attempts
       (purchase_id, reservation_id, attempt, idempotency_key, payment_method, amount_cents, currency, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    [
      purchase.id,
      purchase.reservation_id,
      attempt,
      attemptKey(purchase.reservation_id, attempt),
      paymentMethodToken,
      amountCents,
      purchase.currency,
    ],
  );
  return findAttempt(result.insertId);
}

async function touch(attempt, error) {
  await query('UPDATE payment_attempts SET last_error = ?, updated_at = NOW(3) WHERE id = ?', [
    String(error).slice(0, 255),
    attempt.id,
  ]);
}

export async function sendAuthorization(attempt, userId) {
  try {
    return await authorize({
      amountCents: attempt.amount_cents,
      currency: attempt.currency,
      paymentMethodToken: attempt.payment_method,
      idempotencyKey: attempt.idempotency_key,
      metadata: {
        reservation_id: attempt.reservation_id,
        attempt: attempt.attempt,
        user_id: userId,
      },
    });
  } catch (err) {
    await touch(attempt, err.message);
    throw err;
  }
}

export async function recordAuthorization(attempt, result) {
  if (result.outcome === 'authorized') {
    await query(
      "UPDATE payment_attempts SET status = 'AUTHORIZED', provider_reference = ?, last_error = NULL WHERE id = ?",
      [result.reference, attempt.id],
    );
    return { authorized: true, attempt: await findAttempt(attempt.id) };
  }
  const failedAttempts = await transaction(async (conn) => {
    await query(
      "UPDATE payment_attempts SET status = 'DECLINED', provider_reference = ?, decline_code = ? WHERE id = ?",
      [result.reference, result.declineCode, attempt.id],
      conn,
    );
    await query(
      `UPDATE purchases SET status = 'DECLINED', failed_attempts = failed_attempts + 1,
         payment_provider = ?, payment_reference = COALESCE(?, payment_reference) WHERE id = ?`,
      [providerName, result.reference, attempt.purchase_id],
      conn,
    );
    const [row] = await query(
      'SELECT failed_attempts FROM purchases WHERE id = ?',
      [attempt.purchase_id],
      conn,
    );
    return row.failed_attempts;
  });
  return { authorized: false, failedAttempts, declineCode: result.declineCode };
}

export async function captureAttempt(attempt) {
  try {
    await capture({
      reference: attempt.provider_reference,
      idempotencyKey: `${attempt.idempotency_key}-capture`,
    });
  } catch (err) {
    await touch(attempt, err.message);
    throw err;
  }
}

export async function completePurchase(attempt, items) {
  await transaction(async (conn) => {
    const result = await query(
      `UPDATE purchases SET status = 'PAID', payment_provider = ?, payment_reference = ?,
         ticket_issuance = 'PENDING' WHERE id = ? AND status <> 'PAID'`,
      [providerName, attempt.provider_reference, attempt.purchase_id],
      conn,
    );
    await query(
      "UPDATE payment_attempts SET status = 'CAPTURED', last_error = NULL WHERE id = ?",
      [attempt.id],
      conn,
    );
    if (result.affectedRows !== 1) return;
    for (const item of items) {
      await query(
        'INSERT INTO purchase_items (purchase_id, zone_id, seat_id, quantity, unit_price) VALUES (?, ?, ?, ?, ?)',
        [attempt.purchase_id, item.zoneId, item.seatId ?? null, item.quantity, item.unitPrice],
        conn,
      );
    }
  });
}

async function setStatus(attempt, status, error = null) {
  await query(
    'UPDATE payment_attempts SET status = ?, last_error = ?, updated_at = NOW(3) WHERE id = ?',
    [status, error, attempt.id],
  );
}

export async function undoAttempt(attempt) {
  let status = attempt.status === 'REFUND_PENDING' ? 'REFUND_PENDING' : 'CANCEL_PENDING';
  if (status === 'CANCEL_PENDING') {
    await setStatus(attempt, status);
    try {
      const outcome = await cancel({
        reference: attempt.provider_reference,
        idempotencyKey: `${attempt.idempotency_key}-cancel`,
      });
      if (outcome === 'canceled') return setStatus(attempt, 'CANCELED');
      status = 'REFUND_PENDING';
      await setStatus(attempt, status);
    } catch (err) {
      console.error(`No se pudo cancelar ${attempt.provider_reference}: ${err.message}`);
      return setStatus(attempt, status, err.message.slice(0, 255));
    }
  }
  try {
    await refund({
      reference: attempt.provider_reference,
      idempotencyKey: `${attempt.idempotency_key}-refund`,
    });
    return setStatus(attempt, 'REFUNDED');
  } catch (err) {
    console.error(`No se pudo reembolsar ${attempt.provider_reference}: ${err.message}`);
    return setStatus(attempt, status, err.message.slice(0, 255));
  }
}
