import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import type { Sql } from "../../lib/sql.js";

// Cancelling a whole event. Everything happens in ONE transaction, with set-based SQL,
// so an event with thousands of bookings is cancelled and refunded all-or-nothing.

const ts = (n: number) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;

export type EventCancelResult = {
  bookingsRefunded: number; // paid bookings that were refunded
  bookingsCancelled: number; // pending (and free) bookings that were cancelled
  refunds: Array<{ providerPaymentId: string; amountCents: number }>; // to send to the provider AFTER commit
};

export async function cancelEventWithRefunds(
  sql: Sql,
  input: { eventId: string; actorId: string; now: Date },
): Promise<EventCancelResult> {
  const { eventId, actorId } = input;
  const nowIso = input.now.toISOString();

  // 1. Lock the event. People booking right now hold a shared lock, so we wait for them,
  //    and new bookings wait for us and then see a cancelled event.
  const event = await sql.query<{ status: string }>(
    `SELECT status::text AS status FROM "Event" WHERE id = $1 AND "deletedAt" IS NULL FOR UPDATE`,
    [eventId],
  );
  if (!event[0]) throw AppError.notFound("Event");
  if (event[0].status !== "DRAFT" && event[0].status !== "PUBLISHED") {
    throw AppError.conflict("INVALID_STATE", "Only a draft or published event can be cancelled");
  }

  await sql.execute(`UPDATE "Event" SET status = 'CANCELLED', "updatedAt" = ${ts(2)} WHERE id = $1`, [eventId, nowIso]);

  // 2. Lock every open booking (booking first, like the payment webhook does).
  //    A webhook that is confirming a booking right now finishes first, and we then refund it too.
  await sql.query(
    `SELECT id FROM "Booking" WHERE "eventId" = $1 AND status IN ('PENDING', 'CONFIRMED') ORDER BY id FOR UPDATE`,
    [eventId],
  );

  // 3. Paid bookings: mark the payments REFUNDED and remember them for the provider.
  const refunded = await sql.query<{ id: string; bookingId: string; providerPaymentId: string; amountCents: number }>(
    `UPDATE "Payment" p
        SET status = 'REFUNDED', "updatedAt" = ${ts(2)}
       FROM "Booking" b
      WHERE p."bookingId" = b.id AND b."eventId" = $1 AND b.status = 'CONFIRMED' AND p.status = 'SUCCEEDED'
      RETURNING p.id, p."bookingId", p."providerPaymentId", p."amountCents"`,
    [eventId, nowIso],
  );

  // 4. Bookings: paid ones become REFUNDED, everything else still open becomes CANCELLED.
  const bookingsRefunded = await sql.execute(
    `UPDATE "Booking" b
        SET status = 'REFUNDED', "cancelledAt" = ${ts(2)}, "updatedAt" = ${ts(2)}
      WHERE b."eventId" = $1 AND b.status = 'CONFIRMED'
        AND EXISTS (SELECT 1 FROM "Payment" p WHERE p."bookingId" = b.id AND p.status = 'REFUNDED')`,
    [eventId, nowIso],
  );
  const bookingsCancelled = await sql.execute(
    `UPDATE "Booking"
        SET status = 'CANCELLED', "cancelledAt" = ${ts(2)}, "updatedAt" = ${ts(2)}
      WHERE "eventId" = $1 AND status IN ('PENDING', 'CONFIRMED')`,
    [eventId, nowIso],
  );

  // 5. Nobody owns a seat of a cancelled event any more.
  await sql.execute(
    `UPDATE "BookingItem" SET "isActive" = false
      WHERE "isActive" = true AND "bookingId" IN (SELECT id FROM "Booking" WHERE "eventId" = $1)`,
    [eventId],
  );
  await sql.execute(
    `UPDATE "Seat"
        SET status = 'AVAILABLE', "holdExpiresAt" = NULL, "currentBookingId" = NULL, version = version + 1
      WHERE "eventId" = $1 AND status IN ('HELD', 'SOLD')`,
    [eventId],
  );

  // 6. Audit trail.
  await writeAudit(sql, nowIso, [
    {
      actorId,
      action: "EVENT_CANCELLED",
      entityType: "Event",
      entityId: eventId,
      metadata: { bookingsRefunded, bookingsCancelled },
    },
    ...refunded.map((r) => ({
      actorId,
      action: "PAYMENT_REFUNDED",
      entityType: "Payment",
      entityId: r.id,
      metadata: { bookingId: r.bookingId, reason: "event_cancelled" },
    })),
  ]);

  return {
    bookingsRefunded,
    bookingsCancelled,
    refunds: refunded.map((r) => ({ providerPaymentId: r.providerPaymentId, amountCents: r.amountCents })),
  };
}