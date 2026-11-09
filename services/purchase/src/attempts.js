import { randomUUID } from 'node:crypto';
import { query, transaction } from '@tickethub/common/db';
import { config } from './config.js';
import {
  authorize,
  cancel,
  capture,
  findIntent,
  PaymentCaptureDeclinedError,
  PaymentIdempotencyError,
  providerName,
  refund,
} from './payments/index.js';
import { buildAttemptKey, keyNamespace } from './attempt-key.js';
import { revokeSale } from './services.js';

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
  buildAttemptKey(config.paymentNamespace, reservationId, attempt);

const deploymentOf = (attempt) => {
  const namespace = keyNamespace(attempt);
  return namespace ? { deployment: namespace } : {};
};

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
        ...deploymentOf(attempt),
      },
    });
  } catch (err) {
    if (err instanceof PaymentIdempotencyError) {
      console.error(
        `Intento ${attempt.idempotency_key} no se reintentará; se busca y cancela su autorización: ${err.message}`,
      );
      await setStatus(claim, attempt, 'CANCEL_PENDING', err.message.slice(0, 255));
      await undoAttempt(claim, {
        ...attempt,
        status: 'CANCEL_PENDING',
        last_error: err.message.slice(0, 255),
      }).catch((undoErr) =>
        console.error(`Recuperación de ${attempt.idempotency_key} pendiente: ${undoErr.message}`),
      );
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

async function markCaptureDeclined(claim, attempt, err) {
  await updateAttempt(
    claim,
    attempt.id,
    "a.status = 'CAPTURE_FAILED', a.decline_code = ?, a.last_error = ?",
    [String(err.code ?? 'capture_declined').slice(0, 100), err.message.slice(0, 255)],
  );
}

async function markVoided(claim, attempt) {
  await transaction(async (conn) => {
    await updateAttempt(claim, attempt.id, "a.status = 'CANCELED', a.last_error = NULL", [], conn);
    ensureHeld(
      await query(
        `UPDATE purchases SET status = 'DECLINED', failed_attempts = failed_attempts + 1
          WHERE id = ? AND status <> 'PAID' AND ${CLAIM_HELD}`,
        [attempt.purchase_id, claim.token],
        conn,
      ),
    );
  });
}

async function recoveryFailed(claim, attempt, status, error) {
  const message = String(error).slice(0, 255);
  await updateAttempt(
    claim,
    attempt.id,
    "a.recovery_attempts = a.recovery_attempts + 1, a.status = IF(a.recovery_attempts >= ?, 'RECOVERY_FAILED', ?), a.last_error = ?",
    [config.recoveryMaxAttempts, status, message],
  );
  const current = await findAttempt(attempt.id);
  if (current.status === 'RECOVERY_FAILED') {
    console.error(
      `ALERTA: el intento ${attempt.idempotency_key} (compra ${attempt.purchase_id}, reserva ${attempt.reservation_id}) quedó RECOVERY_FAILED tras ${current.recovery_attempts} intentos de recuperación desde ${status}; requiere revisión manual: ${message}`,
    );
  }
  return current.status;
}

export async function voidDeclinedCapture(claim, attempt) {
  let outcome;
  try {
    outcome = await cancel({
      reference: attempt.provider_reference,
      idempotencyKey: `${attempt.idempotency_key}-cancel`,
    });
  } catch (err) {
    console.error(
      `No se pudo cancelar ${attempt.provider_reference} tras la captura rechazada: ${err.message}`,
    );
    await recoveryFailed(claim, attempt, 'CAPTURE_FAILED', err.message);
    return 'pending';
  }
  if (outcome === 'captured') {
    console.error(`${attempt.provider_reference} sí quedó capturado; se concilia como venta`);
    await setStatus(claim, attempt, 'AUTHORIZED', 'Stripe reporta la captura como hecha');
    return 'captured';
  }
  if (outcome === 'missing') {
    console.error(
      `${attempt.provider_reference} no existe en Stripe al cancelar; no hay cargo y se liberan los asientos`,
    );
  }
  const revoked = await revokeSale(attempt.reservation_id, attempt.purchase_id).catch(() => false);
  if (!revoked) {
    console.error(`No se pudo liberar la reserva ${attempt.reservation_id}; se reintentará`);
    await recoveryFailed(claim, attempt, 'CAPTURE_FAILED', 'Inventory no liberó la venta');
    return 'pending';
  }
  await markVoided(claim, attempt);
  return 'voided';
}

export async function captureOrVoid(claim, attempt) {
  try {
    await captureAttempt(claim, attempt);
  } catch (err) {
    if (err instanceof PaymentCaptureDeclinedError) {
      console.error(
        `Captura rechazada de ${attempt.provider_reference} (compra ${attempt.purchase_id}); se cancela la autorización y se liberan los asientos: ${err.message}`,
      );
      await markCaptureDeclined(claim, attempt, err);
      err.voidOutcome = await voidDeclinedCapture(claim, attempt);
      if (err.voidOutcome === 'captured') return;
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

const RECOVERY_WINDOW_SECONDS = 300;

async function recoverReference(claim, attempt) {
  const deployment = keyNamespace(attempt);
  if (!deployment) {
    console.error(
      `ALERTA: el intento ${attempt.idempotency_key} (compra ${attempt.purchase_id}, reserva ${attempt.reservation_id}) tiene una llave sin PAYMENT_NAMESPACE; no se busca ni se cancela su autorización en Stripe porque podría ser de otro despliegue; requiere revisión manual`,
    );
    return null;
  }
  const found = await findIntent({
    metadata: {
      reservation_id: attempt.reservation_id,
      attempt: attempt.attempt,
      deployment,
    },
    createdAfter: Math.floor(attempt.created_at.getTime() / 1000) - RECOVERY_WINDOW_SECONDS,
  });
  if (!found) return null;
  await updateAttempt(claim, attempt.id, 'a.provider_reference = ?', [found.reference]);
  return found.reference;
}

export async function undoAttempt(claim, attempt) {
  if (!attempt.provider_reference) {
    let reference;
    try {
      reference = await recoverReference(claim, attempt);
    } catch (err) {
      console.error(
        `No se pudo buscar la autorización de ${attempt.idempotency_key}: ${err.message}`,
      );
      return recoveryFailed(claim, attempt, 'CANCEL_PENDING', err.message);
    }
    if (!reference) return setStatus(claim, attempt, 'FAILED', attempt.last_error);
    attempt = { ...attempt, provider_reference: reference };
  }
  let status = attempt.status === 'REFUND_PENDING' ? 'REFUND_PENDING' : 'CANCEL_PENDING';
  if (status === 'CANCEL_PENDING') {
    await setStatus(claim, attempt, status);
    try {
      const outcome = await cancel({
        reference: attempt.provider_reference,
        idempotencyKey: `${attempt.idempotency_key}-cancel`,
      });
      if (outcome === 'canceled' || outcome === 'missing') {
        return setStatus(claim, attempt, 'CANCELED');
      }
      status = 'REFUND_PENDING';
      await setStatus(claim, attempt, status);
    } catch (err) {
      console.error(`No se pudo cancelar ${attempt.provider_reference}: ${err.message}`);
      return recoveryFailed(claim, attempt, status, err.message);
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
    return recoveryFailed(claim, attempt, status, err.message);
  }
}
