import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import { constraintName } from "../../lib/prisma-error.js"
import type { Sql } from "../../lib/sql.js";

// The heart of SeatLock: every statement that decides who owns a seat.
// All functions expect to run INSIDE a database transaction (caller opens it).
//
// Time: Prisma stores DateTime as "timestamp without time zone" in UTC.
// We pass timestamps as ISO strings and convert them with ts() so the database
// session time zone never matters.

const ts = (n: number) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;

// "$3, $4, $5" for dynamic IN (...) lists (at most a few ids, so no array params needed)
const marks = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `$${from + i}`).join(", ");

const ITEM_INDEX = "BookingItem_active_seat_key";

type SeatRow = {
  id: string;
  status: string;
  currentBookingId: string | null;
  priceCents: number;
  currency: string;
  isFree: boolean;
};

// ───────────── Hold seats (create a PENDING booking) ─────────────

export type HoldInput = {
  userId: string;
  eventId: string;
  seatIds: string[];
  idempotencyKey: string;
  holdMinutes: number;
  now: Date;
};

export type HoldResult = { bookingId: string; replayed: boolean };

export async function holdSeats(sql: Sql, input: HoldInput): Promise<HoldResult> {
  const { userId, eventId, idempotencyKey, holdMinutes, now } = input;
  const seatIds = [...new Set(input.seatIds)].sort(); // no duplicates, stable lock order
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + holdMinutes * 60_000).toISOString();

  // 1. Requests of the same user for the same event run one after another.
  await sql.execute(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`booking:${userId}:${eventId}`]);

  // 2. Same Idempotency-Key again? Return the original booking.
  const existing = await sql.query<{ id: string; eventId: string }>(
    `SELECT id, "eventId" FROM "Booking" WHERE "userId" = $1 AND "idempotencyKey" = $2`,
    [userId, idempotencyKey],
  );
  if (existing[0]) {
    const items = await sql.query<{ seatId: string }>(`SELECT "seatId" FROM "BookingItem" WHERE "bookingId" = $1`, [
      existing[0].id,
    ]);
    const sameRequest =
      existing[0].eventId === eventId &&
      items.length === seatIds.length &&
      items.every((i) => seatIds.includes(i.seatId));
    if (!sameRequest) {
      throw new AppError(422, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request");
    }
    return { bookingId: existing[0].id, replayed: true };
  }

  // 3. The event must be open. FOR SHARE makes a concurrent "cancel event" wait for us.
  const event = await sql.query<{ open: boolean }>(
    `SELECT (status = 'PUBLISHED' AND "deletedAt" IS NULL AND "startsAt" > ${ts(2)}) AS open
       FROM "Event" WHERE id = $1 FOR SHARE`,
    [eventId, nowIso],
  );
  if (!event[0]) throw AppError.notFound("Event");
  if (!event[0].open) throw AppError.conflict("EVENT_NOT_BOOKABLE", "This event is not open for booking");

  // 4. One pending booking per user per event (stops one person hoarding seats).
  //    An expired pending booking of this user is cleaned up first.
  const mine = await sql.query<{ id: string; expired: boolean }>(
    `SELECT id, ("expiresAt" <= ${ts(3)}) AS expired
       FROM "Booking" WHERE "userId" = $1 AND "eventId" = $2 AND status = 'PENDING' FOR UPDATE`,
    [userId, eventId, nowIso],
  );
  const staleMine = mine.filter((b) => b.expired).map((b) => b.id);
  if (staleMine.length > 0) await expireBookings(sql, staleMine, nowIso);
  if (mine.some((b) => !b.expired)) {
    throw AppError.conflict("PENDING_BOOKING_EXISTS", "Pay for or cancel your pending booking for this event first");
  }

  // 5. Lock the seats (in id order, so two people wanting overlapping seats cannot deadlock).
  //    Everyone else who wants one of these seats waits here until we commit.
  const seats = await sql.query<SeatRow>(
    `SELECT s.id, s.status::text AS status, s."currentBookingId" AS "currentBookingId",
            t."priceCents" AS "priceCents", t.currency AS currency,
            (s.status = 'AVAILABLE' OR (s.status = 'HELD' AND s."holdExpiresAt" <= ${ts(2)})) AS "isFree"
       FROM "Seat" s JOIN "TicketTier" t ON t.id = s."tierId"
      WHERE s."eventId" = $1 AND s.id IN (${marks(3, seatIds.length)})
      ORDER BY s.id
        FOR UPDATE OF s`,
    [eventId, nowIso, ...seatIds],
  );

  if (seats.length !== seatIds.length) {
    const found = new Set(seats.map((s) => s.id));
    throw AppError.validation(
      seatIds
        .filter((id) => !found.has(id))
        .map((id) => ({ path: "body.seatIds", message: `Seat ${id} does not belong to this event` })),
    );
  }

  const taken = seats.filter((s) => !s.isFree);
  if (taken.length > 0) {
    throw new AppError(
      409,
      "SEAT_UNAVAILABLE",
      "Some seats are no longer available",
      taken.map((s) => ({
        path: "body.seatIds",
        message: `Seat ${s.id} is ${s.status === "SOLD" ? "sold" : "held by someone else"}`,
      })),
    );
  }

  const currency = seats[0]!.currency;
  if (seats.some((s) => s.currency !== currency)) {
    throw AppError.validation([{ path: "body.seatIds", message: "Seats with different currencies cannot be booked together" }]);
  }
  const totalCents = seats.reduce((sum, s) => sum + s.priceCents, 0);

  // 6. Seats whose hold ran out are still marked HELD: release those old bookings now.
  const staleBookingIds = [
    ...new Set(seats.filter((s) => s.status === "HELD" && s.currentBookingId).map((s) => s.currentBookingId!)),
  ];
  if (staleBookingIds.length > 0) await expireBookings(sql, staleBookingIds, nowIso);

  // 7. Create the booking and its items.
  const bookingId = randomUUID();
  await sql.execute(
    `INSERT INTO "Booking" (id, "userId", "eventId", status, "totalCents", currency, "idempotencyKey", "expiresAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'PENDING', $4::int, $5, $6, ${ts(7)}, ${ts(8)}, ${ts(8)})`,
    [bookingId, userId, eventId, totalCents, currency, idempotencyKey, expiresIso, nowIso],
  );

  const itemValues = seats.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}::int, true, ${ts(seats.length * 4 + 1)})`);
  const itemParams = seats.flatMap((s) => [randomUUID(), bookingId, s.id, s.priceCents]);
  try {
    await sql.execute(
      `INSERT INTO "BookingItem" (id, "bookingId", "seatId", "priceCents", "isActive", "createdAt") VALUES ${itemValues.join(", ")}`,
      [...itemParams, nowIso],
    );
  } catch (err) {
    // The partial unique index is the last line of defence against double booking.
    if (constraintName(err) === ITEM_INDEX) {
      throw AppError.conflict("SEAT_UNAVAILABLE", "Some seats are no longer available");
    }
    throw err;
  }

  // 8. The atomic hold: only seats that are still AVAILABLE change.
  //    If even one did not change, throw: the transaction rolls back and nothing is kept.
  const held = await sql.execute(
    `UPDATE "Seat"
        SET status = 'HELD', "holdExpiresAt" = ${ts(2)}, "currentBookingId" = $1, version = version + 1
      WHERE status = 'AVAILABLE' AND id IN (${marks(3, seatIds.length)})`,
    [bookingId, expiresIso, ...seatIds],
  );
  if (held !== seatIds.length) {
    throw AppError.conflict("SEAT_UNAVAILABLE", "Some seats are no longer available");
  }

  await audit(sql, nowIso, [
    { actorId: userId, action: "BOOKING_CREATED", entityId: bookingId, metadata: { seatIds, totalCents, currency } },
  ]);

  return { bookingId, replayed: false };
}

// ───────────── Expire ─────────────

// Marks PENDING bookings EXPIRED and frees their seats. Returns the ids it really expired.
export async function expireBookings(sql: Sql, bookingIds: string[], nowIso: string): Promise<string[]> {
  if (bookingIds.length === 0) return [];

  const expired = await sql.query<{ id: string }>(
    `UPDATE "Booking" SET status = 'EXPIRED', "updatedAt" = ${ts(1)}
      WHERE status = 'PENDING' AND id IN (${marks(2, bookingIds.length)})
      RETURNING id`,
    [nowIso, ...bookingIds],
  );
  const ids = expired.map((r) => r.id);
  if (ids.length === 0) return [];

  await releaseSeats(sql, ids);
  await audit(
    sql,
    nowIso,
    ids.map((id) => ({ actorId: null, action: "BOOKING_EXPIRED", entityId: id })),
  );
  return ids;
}

// Background job: expire every overdue booking.
// SKIP LOCKED lets several app instances run the job at once without clashing.
export async function expireDueBookings(sql: Sql, nowIso: string, limit = 100): Promise<number> {
  const due = await sql.query<{ id: string }>(
    `SELECT id FROM "Booking"
      WHERE status = 'PENDING' AND "expiresAt" <= ${ts(1)}
      ORDER BY "expiresAt"
      LIMIT $2::int
        FOR UPDATE SKIP LOCKED`,
    [nowIso, limit],
  );
  const expired = await expireBookings(sql, due.map((d) => d.id), nowIso);
  return expired.length;
}

// ───────────── Cancel ─────────────

export type CancelInput = {
  bookingId: string;
  actor: { id: string; role: string };
  now: Date;
  /** A confirmed booking can be cancelled until this many hours before the event starts (admins can always). */
  cutoffHours?: number;
};

export type CancelResult = {
  /** Set when money must go back to the customer. The caller refunds AFTER the transaction. */
  refund: { providerPaymentId: string; amountCents: number } | null;
};

// PENDING booking: just release the seats.
// CONFIRMED booking: release the seats AND mark the payment refunded (before the cutoff).
export async function cancelBooking(sql: Sql, input: CancelInput): Promise<CancelResult> {
  const { bookingId, actor } = input;
  const cutoffHours = input.cutoffHours ?? 24;
  const nowIso = input.now.toISOString();

  const rows = await sql.query<{ id: string; userId: string; status: string; windowClosed: boolean }>(
    `SELECT b.id, b."userId", b.status::text AS status,
            (e."startsAt" <= ${ts(2)} + make_interval(hours => $3::int)) AS "windowClosed"
       FROM "Booking" b JOIN "Event" e ON e.id = b."eventId"
      WHERE b.id = $1
        FOR UPDATE OF b`,
    [bookingId, nowIso, cutoffHours],
  );
  const booking = rows[0];

  // Someone else's booking looks like it does not exist.
  if (!booking || (booking.userId !== actor.id && actor.role !== "ADMIN")) {
    throw AppError.notFound("Booking");
  }

  if (booking.status === "PENDING") {
    await sql.execute(
      `UPDATE "Booking" SET status = 'CANCELLED', "cancelledAt" = ${ts(2)}, "updatedAt" = ${ts(2)} WHERE id = $1`,
      [bookingId, nowIso],
    );
    await releaseSeats(sql, [bookingId]);
    await audit(sql, nowIso, [{ actorId: actor.id, action: "BOOKING_CANCELLED", entityId: bookingId }]);
    return { refund: null };
  }

  if (booking.status === "CONFIRMED") {
    if (booking.windowClosed && actor.role !== "ADMIN") {
      throw AppError.conflict(
        "CANCELLATION_WINDOW_CLOSED",
        `A confirmed booking can only be cancelled until ${cutoffHours} hours before the event starts`,
      );
    }

    // Lock order everywhere: booking first, then payment.
    const paid = await sql.query<{ id: string; providerPaymentId: string; amountCents: number }>(
      `SELECT id, "providerPaymentId", "amountCents" FROM "Payment" WHERE "bookingId" = $1 AND status = 'SUCCEEDED' FOR UPDATE`,
      [bookingId],
    );
    const payment = paid[0];

    // Paid booking -> REFUNDED. Free booking (no payment) -> CANCELLED.
    await sql.execute(
      `UPDATE "Booking" SET status = $3::"BookingStatus", "cancelledAt" = ${ts(2)}, "updatedAt" = ${ts(2)} WHERE id = $1`,
      [bookingId, nowIso, payment ? "REFUNDED" : "CANCELLED"],
    );
    if (payment) {
      await sql.execute(`UPDATE "Payment" SET status = 'REFUNDED', "updatedAt" = ${ts(2)} WHERE id = $1`, [payment.id, nowIso]);
    }
    await releaseSeats(sql, [bookingId], { includeSold: true });

    await writeAudit(sql, nowIso, [
      {
        actorId: actor.id,
        action: "BOOKING_CANCELLED",
        entityType: "Booking",
        entityId: bookingId,
        metadata: { refunded: Boolean(payment) },
      },
      ...(payment
        ? [
            {
              actorId: actor.id,
              action: "PAYMENT_REFUNDED",
              entityType: "Payment",
              entityId: payment.id,
              metadata: { bookingId, reason: "booking_cancelled" },
            },
          ]
        : []),
    ]);

    return {
      refund: payment ? { providerPaymentId: payment.providerPaymentId, amountCents: payment.amountCents } : null,
    };
  }

  throw AppError.conflict("INVALID_STATE", "Only a pending or confirmed booking can be cancelled");
}

// ───────────── Helpers ─────────────

// Items stop counting and the seats become AVAILABLE again.
// SOLD seats are only released for a confirmed booking that gets cancelled.
async function releaseSeats(sql: Sql, bookingIds: string[], opts: { includeSold?: boolean } = {}) {
  const statuses = opts.includeSold ? `status IN ('HELD', 'SOLD')` : `status = 'HELD'`;

  await sql.execute(`UPDATE "BookingItem" SET "isActive" = false WHERE "bookingId" IN (${marks(1, bookingIds.length)})`, bookingIds);
  await sql.execute(
    `UPDATE "Seat"
        SET status = 'AVAILABLE', "holdExpiresAt" = NULL, "currentBookingId" = NULL, version = version + 1
      WHERE ${statuses} AND "currentBookingId" IN (${marks(1, bookingIds.length)})`,
    bookingIds,
  );
}

type AuditEntry = { actorId: string | null; action: string; entityId: string; metadata?: unknown };

async function audit(sql: Sql, nowIso: string, entries: AuditEntry[]) {
  if (entries.length === 0) return;

  const values = entries.map(
    (_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, 'Booking', $${i * 5 + 4}, $${i * 5 + 5}::jsonb, ${ts(entries.length * 5 + 1)})`,
  );
  const params = entries.flatMap((e) => [
    randomUUID(),
    e.actorId,
    e.action,
    e.entityId,
    e.metadata === undefined ? null : JSON.stringify(e.metadata),
  ]);
  await sql.execute(
    `INSERT INTO "AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt") VALUES ${values.join(", ")}`,
    [...params, nowIso],
  );
}