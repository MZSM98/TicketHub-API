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
    return { ticketIssuance: 'PENDING', ticketIds: [] };
  }
}

let retrying = false;
export async function retryPendingTickets() {
  if (retrying) return;
  retrying = true;
  try {
    const rows = await query(
      "SELECT id FROM purchases WHERE status = 'PAID' AND ticket_issuance = 'PENDING' ORDER BY id LIMIT 50",
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
