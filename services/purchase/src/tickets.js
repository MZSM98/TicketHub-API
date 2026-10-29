import { query } from '@tickethub/common/db';
import { config } from './config.js';
import { issueTickets } from './services.js';

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

const baseSeconds = () => Math.max(1, config.ticketRetryMs / 1000 || 30);

async function scheduleRetry(purchaseId) {
  await query(
    `UPDATE purchases
        SET ticket_attempts = ticket_attempts + 1,
            ticket_next_retry_at = DATE_ADD(NOW(3), INTERVAL LEAST(? * POW(2, ticket_attempts), ?) SECOND)
      WHERE id = ? AND ticket_issuance = 'PENDING'`,
    [baseSeconds(), config.ticketRetryMaxSeconds, purchaseId],
  );
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
