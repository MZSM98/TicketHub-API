import { query, transaction } from '@tickethub/common/db';
import { HttpError } from '@tickethub/common/http';
import { config } from './config.js';
import { CURRENCY } from './zones.js';

export const reservationNotFound = () =>
  new HttpError(404, 'RESERVATION_NOT_FOUND', 'La reserva no existe');
export const reservationExpired = () => new HttpError(410, 'RESERVATION_EXPIRED', 'Tiempo agotado');
export const alreadyConfirmed = () =>
  new HttpError(
    409,
    'RESERVATION_ALREADY_CONFIRMED',
    'La reserva ya fue pagada y no se puede cancelar',
  );
export const activeReservationExists = (reservationId) =>
  new HttpError(
    409,
    'ACTIVE_RESERVATION_EXISTS',
    'Ya tiene una reserva activa, termínela o cancélela primero',
    { reservationId },
  );
const reservationFailed = () =>
  new HttpError(500, 'RESERVATION_FAILED', 'Error al procesar reserva');

const iso = (date) => date.toISOString().replace('.000Z', 'Z');
const toSeconds = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const toCents = (money) => Number(money.replace('.', ''));
const fromCents = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

const RESERVATION_COLUMNS = 'id, user_id, event_id, status, purchase_id, expires_at, created_at';

const isExpired = (row) => row.status === 'ACTIVE' && row.expires_at.getTime() <= Date.now();

async function loadItems(reservationId, conn) {
  return query(
    `SELECT ri.zone_id, z.name AS zone_name, ri.seat_id, s.row_label, s.seat_number,
       ri.quantity, ri.unit_price
     FROM reservation_items ri
     JOIN zones z ON z.id = ri.zone_id
     LEFT JOIN seats s ON s.id = ri.seat_id
     WHERE ri.reservation_id = ? ORDER BY ri.id`,
    [reservationId],
    conn,
  );
}

export async function toReservation(row, conn) {
  const items = await loadItems(row.id, conn);
  const status = isExpired(row) ? 'EXPIRED' : row.status;
  const remaining =
    status === 'ACTIVE'
      ? Math.max(0, Math.ceil((row.expires_at.getTime() - Date.now()) / 1000))
      : 0;
  const total = items.reduce((sum, item) => sum + toCents(item.unit_price) * item.quantity, 0);
  return {
    id: row.id,
    userId: row.user_id,
    eventId: row.event_id,
    status,
    purchaseId: row.purchase_id ?? null,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    secondsRemaining: remaining,
    total: fromCents(total),
    currency: CURRENCY,
    items: items.map((item) => ({
      zoneId: item.zone_id,
      zoneName: item.zone_name,
      seatId: item.seat_id,
      rowLabel: item.row_label,
      seatNumber: item.seat_number,
      quantity: item.quantity,
      unitPrice: item.unit_price,
    })),
  };
}

async function quantitiesByZone(reservationId, conn) {
  return query(
    `SELECT zone_id, SUM(quantity) AS quantity FROM reservation_items
     WHERE reservation_id = ? GROUP BY zone_id ORDER BY zone_id`,
    [reservationId],
    conn,
  );
}

async function releaseLocked(conn, row, status) {
  await query(
    "UPDATE seats SET status = 'AVAILABLE', reservation_id = NULL WHERE reservation_id = ? AND status = 'RESERVED'",
    [row.id],
    conn,
  );
  for (const { zone_id: zoneId, quantity } of await quantitiesByZone(row.id, conn)) {
    await query(
      'UPDATE zones SET reserved_count = reserved_count - ? WHERE id = ?',
      [Number(quantity), zoneId],
      conn,
    );
  }
  await query('UPDATE reservations SET status = ? WHERE id = ?', [status, row.id], conn);
  row.status = status;
}

async function confirmLocked(conn, row, purchaseId) {
  await query(
    "UPDATE seats SET status = 'SOLD' WHERE reservation_id = ? AND status = 'RESERVED'",
    [row.id],
    conn,
  );
  for (const { zone_id: zoneId, quantity } of await quantitiesByZone(row.id, conn)) {
    await query(
      'UPDATE zones SET reserved_count = reserved_count - ?, sold_count = sold_count + ? WHERE id = ?',
      [Number(quantity), Number(quantity), zoneId],
      conn,
    );
  }
  await query(
    "UPDATE reservations SET status = 'CONFIRMED', purchase_id = ? WHERE id = ?",
    [purchaseId, row.id],
    conn,
  );
  row.status = 'CONFIRMED';
  row.purchase_id = purchaseId;
}

async function revokeLocked(conn, row) {
  await query(
    "UPDATE seats SET status = 'AVAILABLE', reservation_id = NULL WHERE reservation_id = ? AND status = 'SOLD'",
    [row.id],
    conn,
  );
  for (const { zone_id: zoneId, quantity } of await quantitiesByZone(row.id, conn)) {
    await query(
      'UPDATE zones SET sold_count = sold_count - ? WHERE id = ?',
      [Number(quantity), zoneId],
      conn,
    );
  }
  await query(
    "UPDATE reservations SET status = 'CANCELLED', purchase_id = NULL WHERE id = ?",
    [row.id],
    conn,
  );
  row.status = 'CANCELLED';
  row.purchase_id = null;
}

const isLockFailure = (err) => err?.errno === 1213 || err?.errno === 1205;

async function withRetry(work) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (!isLockFailure(err)) throw err;
      if (attempt >= 3) {
        console.error(err);
        throw reservationFailed();
      }
    }
  }
}

export async function expireDue() {
  let released;
  do {
    released = await withRetry(() =>
      transaction(async (conn) => {
        const rows = await query(
          `SELECT ${RESERVATION_COLUMNS} FROM reservations
           WHERE status = 'ACTIVE' AND expires_at <= ? ORDER BY id LIMIT 50
           FOR UPDATE SKIP LOCKED`,
          [new Date()],
          conn,
        );
        for (const row of rows) await releaseLocked(conn, row, 'EXPIRED');
        return rows.length;
      }),
    );
  } while (released === 50);
}

export async function withReservation(reservationId, action = () => null) {
  let row;
  const outcome = await withRetry(() =>
    transaction(async (conn) => {
      [row] = await query(
        `SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE id = ? FOR UPDATE`,
        [reservationId],
        conn,
      );
      if (!row) return reservationNotFound();
      if (isExpired(row)) await releaseLocked(conn, row, 'EXPIRED');
      return action(row, conn);
    }),
  );
  if (outcome instanceof HttpError) throw outcome;
  return toReservation(row);
}

export async function activeReservationIdOf(userId) {
  const [row] = await query("SELECT id FROM reservations WHERE user_id = ? AND status = 'ACTIVE'", [
    userId,
  ]);
  return row?.id ?? null;
}

export async function activeReservationOf(userId) {
  const id = await activeReservationIdOf(userId);
  if (!id) return null;
  const reservation = await withReservation(id);
  return reservation.status === 'ACTIVE' ? reservation : null;
}

export const cancelAction = (row, conn) => {
  if (row.status === 'CONFIRMED') return alreadyConfirmed();
  if (row.status === 'EXPIRED') return reservationExpired();
  if (row.status === 'ACTIVE') return releaseLocked(conn, row, 'CANCELLED');
  return null;
};

export const releaseAction = (row, conn) => {
  if (row.status === 'CONFIRMED') return alreadyConfirmed();
  if (row.status === 'ACTIVE') return releaseLocked(conn, row, 'CANCELLED');
  return null;
};

const invalidState = (status) =>
  new HttpError(409, 'INVALID_RESERVATION_STATE', 'La reserva no se puede confirmar', { status });

export const confirmAction = (purchaseId) => async (row, conn) => {
  if (row.status === 'EXPIRED') return reservationExpired();
  if (row.status === 'CONFIRMED') {
    return row.purchase_id === purchaseId ? null : invalidState(row.status);
  }
  if (row.status !== 'ACTIVE') return invalidState(row.status);
  const [used] = await query(
    'SELECT id FROM reservations WHERE purchase_id = ?',
    [purchaseId],
    conn,
  );
  if (used) return invalidState(row.status);
  return confirmLocked(conn, row, purchaseId);
};

export const revokeSaleAction = (purchaseId) => async (row, conn) => {
  if (row.status === 'CONFIRMED') {
    if (row.purchase_id !== purchaseId) return invalidState(row.status);
    return revokeLocked(conn, row);
  }
  if (row.status === 'ACTIVE') return invalidState(row.status);
  return null;
};

const itemNotValid = (index, field) =>
  new HttpError(
    400,
    'VALIDATION_ERROR',
    'Algunos datos no son válidos, revise los campos marcados',
    {
      fields: [{ field: `items[${index}].${field}`, issue: 'invalid_value' }],
    },
  );

export async function createReservation(userId, eventId, items) {
  const seatItems = items.filter((item) => item.seatId !== undefined);
  const generalItems = items.filter((item) => item.zoneId !== undefined);
  const seatIds = seatItems.map((item) => item.seatId);
  let reservationId;
  try {
    reservationId = await withRetry(() =>
      transaction(async (conn) => {
        const placesByZone = new Map();
        const priceByZone = new Map();
        let seats = [];
        if (seatIds.length > 0) {
          seats = await query(
            `SELECT s.id, s.zone_id, s.status, z.event_id, z.price FROM seats s
             JOIN zones z ON z.id = s.zone_id
             WHERE s.id IN (${seatIds.map(() => '?').join(',')}) ORDER BY s.id FOR UPDATE OF s`,
            seatIds,
            conn,
          );
          const byId = new Map(seats.map((seat) => [seat.id, seat]));
          for (const [index, seatId] of seatIds.entries()) {
            if (byId.get(seatId)?.event_id !== eventId)
              throw itemNotValid(items.indexOf(seatItems[index]), 'seatId');
          }
          const unavailable = seats.filter((seat) => seat.status !== 'AVAILABLE').map((s) => s.id);
          if (unavailable.length > 0) {
            throw new HttpError(409, 'SEAT_UNAVAILABLE', 'Asiento ya no disponible', {
              unavailableSeatIds: unavailable,
            });
          }
          for (const seat of seats) {
            placesByZone.set(seat.zone_id, (placesByZone.get(seat.zone_id) ?? 0) + 1);
            priceByZone.set(seat.zone_id, seat.price);
          }
        }
        if (generalItems.length > 0) {
          const zoneIds = generalItems.map((item) => item.zoneId);
          const zones = await query(
            `SELECT id, event_id, type, price FROM zones WHERE id IN (${zoneIds.map(() => '?').join(',')})`,
            zoneIds,
            conn,
          );
          const byId = new Map(zones.map((zone) => [zone.id, zone]));
          for (const item of generalItems) {
            const zone = byId.get(item.zoneId);
            if (zone?.event_id !== eventId || zone.type !== 'GENERAL') {
              throw itemNotValid(items.indexOf(item), 'zoneId');
            }
            placesByZone.set(zone.id, (placesByZone.get(zone.id) ?? 0) + item.quantity);
            priceByZone.set(zone.id, zone.price);
          }
        }
        const now = Date.now();
        const result = await query(
          `INSERT INTO reservations (user_id, event_id, status, expires_at, created_at)
           VALUES (?, ?, 'ACTIVE', ?, ?)`,
          [userId, eventId, toSeconds(now + config.reservationTtlMs), toSeconds(now)],
          conn,
        );
        const id = result.insertId;
        if (seatIds.length > 0) {
          const updated = await query(
            `UPDATE seats SET status = 'RESERVED', reservation_id = ?
             WHERE id IN (${seatIds.map(() => '?').join(',')}) AND status = 'AVAILABLE'`,
            [id, ...seatIds],
            conn,
          );
          if (updated.affectedRows !== seatIds.length) throw new Error('Asientos sin bloquear');
        }
        for (const zoneId of [...placesByZone.keys()].sort((a, b) => a - b)) {
          const places = placesByZone.get(zoneId);
          const updated = await query(
            `UPDATE zones SET reserved_count = reserved_count + ?
             WHERE id = ? AND reserved_count + sold_count + ? <= capacity`,
            [places, zoneId, places],
            conn,
          );
          if (updated.affectedRows === 0) {
            const [zone] = await query(
              'SELECT capacity - reserved_count - sold_count AS available FROM zones WHERE id = ? FOR UPDATE',
              [zoneId],
              conn,
            );
            throw new HttpError(
              409,
              'ZONE_CAPACITY_EXCEEDED',
              'No hay suficientes lugares disponibles en la zona',
              { zoneId, available: Number(zone?.available ?? 0) },
            );
          }
        }
        for (const seat of seats) {
          await query(
            'INSERT INTO reservation_items (reservation_id, zone_id, seat_id, quantity, unit_price) VALUES (?, ?, ?, 1, ?)',
            [id, seat.zone_id, seat.id, seat.price],
            conn,
          );
        }
        for (const item of generalItems) {
          await query(
            'INSERT INTO reservation_items (reservation_id, zone_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
            [id, item.zoneId, item.quantity, priceByZone.get(item.zoneId)],
            conn,
          );
        }
        return id;
      }),
    );
  } catch (err) {
    if (err?.errno === 1062) {
      throw activeReservationExists(await activeReservationIdOf(userId));
    }
    throw err;
  }
  const [row] = await query(`SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE id = ?`, [
    reservationId,
  ]);
  return toReservation(row);
}
