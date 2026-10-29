import { randomUUID } from 'node:crypto';
import { query, transaction } from '@tickethub/common/db';
import { config } from './config.js';
import {
  authorize,
  cancel,
  capture,
  PaymentIdempotencyError,
  PaymentProviderError,
  providerName,
  refund,
} from './payments/index.js';

export class ClaimLostError extends Error {
  constructor() {
    super('El reclamo de la compra expiró o pasó a otro proceso');
  }
}

const CLAIM_HELD = 'claim_token = ? AND claimed_until > NOW(3)';

function ensureHeld(result) {
  if (result.affectedRows !== 1) throw new ClaimLostError();
}

async function updateAttempt(claim, attemptId, assignments, params, conn) {
  ensureHeld(
    await query(
      `UPDATE payment_attempts a JOIN purchases p ON p.id = a.purchase_id
          SET ${assignments}, a.updated_at = NOW(3)
        WHERE a.id = ? AND p.${CLAIM_HELD}`,
      [...params, attemptId, claim.token],
      conn,
    ),
  );
}

export const attemptKey = (reservationId, attempt) =>
  `tickethub-reservation-${reservationId}-attempt-${attempt}`;

export async function claimPurchase(purchaseId) {
  const token = randomUUID();
  const result = await query(
    `UPDATE purchases SET claim_token = ?, claimed_until = DATE_ADD(NOW(3), INTERVAL ? SECOND)
      WHERE id = ? AND (claimed_until IS NULL OR claimed_until < NOW(3))`,
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

export async function latestAttempt(purchaseId) {
  const [row] = await query(
    'SELECT * FROM payment_attempts WHERE purchase_id = ? ORDER BY attempt DESC LIMIT 1',
    [purchaseId],
  );
  return row ?? null;
}

export async function openAttempt(purchaseId) {
  const [row] = await query(
    `SELECT * FROM payment_attempts WHERE purchase_id = ? AND status IN ('PENDING', 'AUTHORIZED')
      ORDER BY attempt DESC LIMIT 1`,
    [purchaseId],
  );
  return row ?? null;
}

export async function createAttempt(claim, purchase, paymentMethodToken, amountCents) {
  const id = await transaction(async (conn) => {
    const held = await query(
      `SELECT id FROM purchases WHERE id = ? AND ${CLAIM_HELD} FOR UPDATE`,
      [purchase.id, claim.token],
      conn,
    );
    if (held.length !== 1) throw new ClaimLostError();
    const [{ last }] = await query(
      'SELECT COALESCE(MAX(attempt), 0) AS last FROM payment_attempts WHERE purchase_id = ?',
      [purchase.id],
      conn,
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
      conn,
    );
    return result.insertId;
  });
  return findAttempt(id);
}

async function touch(claim, attempt, error) {
  await updateAttempt(claim, attempt.id, 'a.last_error = ?', [String(error).slice(0, 255)]);
}

export async function sendAuthorization(claim, attempt, userId) {
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
    if (err instanceof PaymentIdempotencyError) {
      console.error(
        `Intento ${attempt.idempotency_key} marcado FAILED, no se reintentará: ${err.message}`,
      );
      await setStatus(claim, attempt, 'FAILED', err.message.slice(0, 255));
    } else {
      await touch(claim, attempt, err.message);
    }
    throw err;
  }
}

export async function recordAuthorization(claim, attempt, result) {
  if (result.outcome === 'authorized') {
    await updateAttempt(
      claim,
      attempt.id,
      "a.status = 'AUTHORIZED', a.provider_reference = ?, a.last_error = NULL",
      [result.reference],
    );
    return { authorized: true, attempt: await findAttempt(attempt.id) };
  }
  const failedAttempts = await transaction(async (conn) => {
    await updateAttempt(
      claim,
      attempt.id,
      "a.status = 'DECLINED', a.provider_reference = ?, a.decline_code = ?",
      [result.reference, result.declineCode],
      conn,
    );
    ensureHeld(
      await query(
        `UPDATE purchases SET status = 'DECLINED', failed_attempts = failed_attempts + 1,
           payment_provider = ?, payment_reference = COALESCE(?, payment_reference)
         WHERE id = ? AND ${CLAIM_HELD}`,
        [providerName, result.reference, attempt.purchase_id, claim.token],
        conn,
      ),
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

export async function captureAttempt(claim, attempt) {
  try {
    await capture({
      reference: attempt.provider_reference,
      idempotencyKey: `${attempt.idempotency_key}-capture`,
    });
  } catch (err) {
    await touch(claim, attempt, err.message);
    throw err;
  }
}

export async function captureOrMarkFailed(claim, attempt) {
  try {
    await captureAttempt(claim, attempt);
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      console.error(
        `Captura rechazada de ${attempt.provider_reference} (compra ${attempt.purchase_id}); la venta queda confirmada y requiere revisión: ${err.message}`,
      );
      await setStatus(claim, attempt, 'CAPTURE_FAILED', err.message.slice(0, 255));
    }
    throw err;
  }
}

function mergeGeneralItems(items) {
  const merged = [];
  const byZone = new Map();
  for (const item of items) {
    if (item.seatId) {
      merged.push(item);
      continue;
    }
    const existing = byZone.get(item.zoneId);
    if (existing) existing.quantity += item.quantity;
    else {
      const copy = { ...item, seatId: null };
      byZone.set(item.zoneId, copy);
      merged.push(copy);
    }
  }
  return merged;
}

export async function completePurchase(claim, attempt, items) {
  await transaction(async (conn) => {
    await updateAttempt(claim, attempt.id, "a.status = 'CAPTURED', a.last_error = NULL", [], conn);
    const result = await query(
      `UPDATE purchases SET status = 'PAID', payment_provider = ?, payment_reference = ?,
         ticket_issuance = 'PENDING', ticket_next_retry_at = NOW(3)
       WHERE id = ? AND status <> 'PAID' AND ${CLAIM_HELD}`,
      [providerName, attempt.provider_reference, attempt.purchase_id, claim.token],
      conn,
    );
    if (result.affectedRows !== 1) return;
    for (const item of mergeGeneralItems(items)) {
      await query(
        'INSERT INTO purchase_items (purchase_id, zone_id, seat_id, quantity, unit_price) VALUES (?, ?, ?, ?, ?)',
        [attempt.purchase_id, item.zoneId, item.seatId ?? null, item.quantity, item.unitPrice],
        conn,
      );
    }
  });
}

async function setStatus(claim, attempt, status, error = null) {
  await updateAttempt(claim, attempt.id, 'a.status = ?, a.last_error = ?', [status, error]);
}

export async function undoAttempt(claim, attempt) {
  let status = attempt.status === 'REFUND_PENDING' ? 'REFUND_PENDING' : 'CANCEL_PENDING';
  if (status === 'CANCEL_PENDING') {
    await setStatus(claim, attempt, status);
    try {
      const outcome = await cancel({
        reference: attempt.provider_reference,
        idempotencyKey: `${attempt.idempotency_key}-cancel`,
      });
      if (outcome === 'canceled') return setStatus(claim, attempt, 'CANCELED');
      status = 'REFUND_PENDING';
      await setStatus(claim, attempt, status);
    } catch (err) {
      console.error(`No se pudo cancelar ${attempt.provider_reference}: ${err.message}`);
      return setStatus(claim, attempt, status, err.message.slice(0, 255));
    }
  }
  try {
    await refund({
      reference: attempt.provider_reference,
      idempotencyKey: `${attempt.idempotency_key}-refund`,
    });
    return setStatus(claim, attempt, 'REFUNDED');
  } catch (err) {
    console.error(`No se pudo reembolsar ${attempt.provider_reference}: ${err.message}`);
    return setStatus(claim, attempt, status, err.message.slice(0, 255));
  }
}
