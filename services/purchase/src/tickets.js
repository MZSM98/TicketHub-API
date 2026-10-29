import { config } from './config.js';
import { issueTickets } from './services.js';

const pending = new Map();

const payloadOf = (purchase, reservation) => ({
  purchaseId: purchase.id,
  userId: purchase.userId,
  eventId: purchase.eventId,
  items: reservation.items.map((item) => ({
    zoneId: item.zoneId,
    seatId: item.seatId ?? null,
    quantity: item.quantity,
  })),
});

export async function issueFor(purchase, reservation) {
  const payload = payloadOf(purchase, reservation);
  try {
    const ticketIds = await issueTickets(payload);
    return { ticketIssuance: 'ISSUED', ticketIds };
  } catch (err) {
    console.error(`Emisión de boletos de la compra ${purchase.id} en cola: ${err.message}`);
    pending.set(purchase.id, payload);
    return { ticketIssuance: 'PENDING', ticketIds: [] };
  }
}

let retrying = false;
async function retryPending() {
  if (retrying) return;
  retrying = true;
  try {
    for (const [purchaseId, payload] of pending) {
      try {
        await issueTickets(payload);
        pending.delete(purchaseId);
      } catch (err) {
        console.error(`Reintento de boletos de la compra ${purchaseId} falló: ${err.message}`);
      }
    }
  } finally {
    retrying = false;
  }
}

export function startTicketRetries() {
  if (config.ticketRetryMs <= 0) return null;
  return setInterval(retryPending, config.ticketRetryMs);
}
