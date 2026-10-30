import { query } from '@tickethub/common/db';
import { config } from './config.js';
import { issueTickets } from './services.js';

const MAX_BACKOFF_EXPONENT = 30;

async function payloadOf(purchaseId) {
  const [purchase] = await query('SELECT id, user_id, event_id FROM purchases WHERE id = ?', [
    purchaseId,
  ]);
  const items = await query(
    'SELECT zone_id, seat_id, quantity FROM purchase_items WHERE purchase_id = ? ORDER BY id',
    [purchaseId],
  );
  return {
    purchaseId: purchase.id,
    userId: purchase.user_id,
    eventId: purchase.event_id,
    items: items.map((item) => ({
      zoneId: item.zone_id,
      seatId: item.seat_id ?? null,
      quantity: item.quantity,
    })),
  };
}

async function scheduleRetry(purchaseId) {
  await query(
    `UPDATE purchases
        SET ticket_attempts = ticket_attempts + 1,
            ticket_issuance = IF(ticket_attempts >= ?, 'FAILED', 'PENDING'),
            ticket_next_retry_at = DATE_ADD(NOW(3), INTERVAL LEAST(? * POW(2, LEAST(ticket_attempts, ?)), ?) SECOND)
      WHERE id = ? AND ticket_issuance = 'PENDING'`,
    [
      config.ticketRetryMaxAttempts,
      config.ticketRetryBackoffSeconds,
      MAX_BACKOFF_EXPONENT,
      config.ticketRetryMaxSeconds,
      purchaseId,
    ],
  );
  const [row] = await query('SELECT ticket_issuance, ticket_attempts FROM purchases WHERE id = ?', [
    purchaseId,
  ]);
  if (row?.ticket_issuance === 'FAILED') {
    console.error(
      `Emisión de boletos de la compra ${purchaseId} marcada FAILED tras ${row.ticket_attempts} intentos; requiere revisión`,
    );
  }
}

export async function issueFor(purchaseId) {
  try {
    const ticketIds = await issueTickets(await payloadOf(purchaseId));
    await query("UPDATE purchases SET ticket_issuance = 'ISSUED', ticket_ids = ? WHERE id = ?", [
      JSON.stringify(ticketIds),
      purchaseId,
    ]);
    return { ticketIssuance: 'ISSUED', ticketIds };
  } catch (err) {
    console.error(`Emisión de boletos de la compra ${purchaseId} pendiente: ${err.message}`);
    await scheduleRetry(purchaseId).catch(() => null);
    return { ticketIssuance: 'PENDING', ticketIds: [] };
  }
}

let retrying = false;
export async function retryPendingTickets() {
  if (retrying) return;
  retrying = true;
  try {
    const rows = await query(
      `SELECT id FROM purchases
        WHERE status = 'PAID' AND ticket_issuance = 'PENDING' AND ticket_next_retry_at <= NOW(3)
        ORDER BY ticket_next_retry_at, id LIMIT ${config.ticketRetryBatch}`,
    );
    for (const { id } of rows) await issueFor(id);
  } catch (err) {
    console.error(`Reintento de boletos falló: ${err.message}`);
  } finally {
    retrying = false;
  }
}

export function startTicketRetries() {
  if (config.ticketRetryMs <= 0) return null;
  return setInterval(retryPendingTickets, config.ticketRetryMs);
}
