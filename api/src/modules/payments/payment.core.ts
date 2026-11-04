import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import type { Sql } from "../../lib/sql.js";
import type { PaymentEvent } from "./payment.provider.js";

// Everything that decides whether money turns into a ticket.
// All functions run INSIDE a database transaction opened by the caller.
// Talking to the payment company (refund calls) happens AFTER the transaction, in the service.

const ts = (n: number) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;
const marks = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `$${from + i}`).join(", ");

// ───────────── Start a payment ─────────────

export type InitiateInput = {
  bookingId: string;
  userId: string;
  now: Date;
  createWithProvider: (p: {
    bookingId: string;
    amountCents: number;
    currency: string;
  }) => Promise<{ providerPaymentId: string; checkout: unknown }>;
  providerName: string;
};

export type InitiateResult =
  | {
      kind: "payment";
      paymentId: string;
      providerPaymentId: string;
      status: string;
      amountCents: number;
      currency: string;
      checkout: unknown | null; // null when we return an existing payment
      replayed: boolean;
    }
  | { kind: "free"; bookingId: string };

export async function initiatePayment(sql: Sql, input: InitiateInput): Promise<InitiateResult> {
  const { bookingId, userId, providerName } = input;
  const nowIso = input.now.toISOString();

  // Lock the booking: two "pay" clicks at the same time wait for each other.
  const rows = await sql.query<{
    id: string;
    userId: string;
    status: string;
    expired: boolean;
    totalCents: number;
    currency: string;
  }>(
    `SELECT id, "userId", status::text AS status, ("expiresAt" <= ${ts(2)}) AS expired, "totalCents", currency
       FROM "Booking" WHERE id = $1 FOR UPDATE`,
    [bookingId, nowIso],
  );
  const booking = rows[0];

  // Someone else's booking looks like it does not exist.
  if (!booking || booking.userId !== userId) throw AppError.notFound("Booking");
  if (booking.status === "CONFIRMED") throw AppError.conflict("ALREADY_PAID", "This booking is already paid");
  if (booking.status !== "PENDING") throw AppError.conflict("INVALID_STATE", "Only a pending booking can be paid");
  if (booking.expired) {
    throw AppError.conflict("BOOKING_EXPIRED", "The hold on these seats has expired. Please book again");
  }

  // Free tickets need no payment.
  if (booking.totalCents === 0) {
    await confirmBooking(sql, bookingId, nowIso);
    await writeAudit(sql, nowIso, [
      { actorId: userId, action: "BOOKING_CONFIRMED_FREE", entityType: "Booking", entityId: bookingId },
    ]);
    return { kind: "free", bookingId };
  }

  // Already started? Return the same payment instead of creating a second one.
  const existing = await sql.query<{
    id: string;
    providerPaymentId: string;
    status: string;
    amountCents: number;
    currency: string;
  }>(
    `SELECT id, "providerPaymentId", status::text AS status, "amountCents", currency
       FROM "Payment" WHERE "bookingId" = $1 AND status = 'INITIATED'`,
    [bookingId],
  );
  if (existing[0]) {
    return { kind: "payment", paymentId: existing[0].id, ...existing[0], checkout: null, replayed: true };
  }

  const created = await input.createWithProvider({
    bookingId,
    amountCents: booking.totalCents,
    currency: booking.currency,
  });

  const paymentId = randomUUID();
  await sql.execute(
    `INSERT INTO "Payment" (id, "bookingId", provider, "providerPaymentId", status, "amountCents", currency, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'INITIATED', $5::int, $6, ${ts(7)}, ${ts(7)})`,
    [paymentId, bookingId, providerName, created.providerPaymentId, booking.totalCents, booking.currency, nowIso],
  );
  await writeAudit(sql, nowIso, [
    {
      actorId: userId,
      action: "PAYMENT_INITIATED",
      entityType: "Payment",
      entityId: paymentId,
      metadata: { bookingId, amountCents: booking.totalCents },
    },
  ]);

  return {
    kind: "payment",
    paymentId,
    providerPaymentId: created.providerPaymentId,
    status: "INITIATED",
    amountCents: booking.totalCents,
    currency: booking.currency,
    checkout: created.checkout,
    replayed: false,
  };
}

// ───────────── Webhook ─────────────

export type WebhookOutcome =
  | { result: "duplicate" }
  | { result: "ignored"; reason: string }
  | {
      result: "processed";
      action: "confirmed" | "reconfirmed" | "payment_failed" | "already_processed" | "refund_required";
      // set when the customer paid but we cannot give the ticket: refund after the transaction
      refund?: { providerPaymentId: string; amountCents: number };
    };

export type WebhookInput = { event: PaymentEvent; provider: string; now: Date };

export async function processWebhookEvent(sql: Sql, input: WebhookInput): Promise<WebhookOutcome> {
  const { event, provider } = input;
  const nowIso = input.now.toISOString();

  // 1. Have we seen this event id before? The unique index makes this safe even when
  //    the same event arrives twice at the same moment: the second one waits, then sees the row.
  //    Because this INSERT is in the same transaction as the work below, a crash rolls it back
  //    and the provider's retry is processed normally.
  const inserted = await sql.query<{ id: string }>(
    `INSERT INTO "WebhookEvent" (id, provider, "providerEventId", type, payload, status, "receivedAt")
     VALUES ($1, $2, $3, $4, $5::jsonb, 'RECEIVED', ${ts(6)})
     ON CONFLICT ("providerEventId") DO NOTHING
     RETURNING id`,
    [randomUUID(), provider, event.id, event.type, JSON.stringify(event.raw), nowIso],
  );
  if (!inserted[0]) return { result: "duplicate" };
  const webhookId = inserted[0].id;

  const finish = (status: "PROCESSED" | "FAILED", error?: string) =>
    sql.execute(
      `UPDATE "WebhookEvent" SET status = $2::"WebhookStatus", error = $3, "processedAt" = ${ts(4)} WHERE id = $1`,
      [webhookId, status, error ?? null, nowIso],
    );

  // 2. Which payment is this about?
  const found = await sql.query<{ id: string; bookingId: string }>(
    `SELECT id, "bookingId" FROM "Payment" WHERE "providerPaymentId" = $1`,
    [event.providerPaymentId],
  );
  if (!found[0]) {
    await finish("FAILED", "Unknown payment");
    return { result: "ignored", reason: "unknown payment" };
  }

  // 3. Lock booking first, then payment (always this order).
  const bookingRows = await sql.query<{ id: string; userId: string; status: string }>(
    `SELECT id, "userId", status::text AS status FROM "Booking" WHERE id = $1 FOR UPDATE`,
    [found[0].bookingId],
  );
  const paymentRows = await sql.query<{ id: string; status: string; amountCents: number; currency: string }>(
    `SELECT id, status::text AS status, "amountCents", currency FROM "Payment" WHERE id = $1 FOR UPDATE`,
    [found[0].id],
  );
  const booking = bookingRows[0]!;
  const payment = paymentRows[0]!;

  // 4. The payment failed: the booking stays PENDING so the customer can try again.
  if (event.type === "payment.failed") {
    if (payment.status === "INITIATED") {
      await sql.execute(`UPDATE "Payment" SET status = 'FAILED', "updatedAt" = ${ts(2)} WHERE id = $1`, [payment.id, nowIso]);
      await writeAudit(sql, nowIso, [
        { actorId: null, action: "PAYMENT_FAILED", entityType: "Payment", entityId: payment.id, metadata: { bookingId: booking.id } },
      ]);
      await finish("PROCESSED");
      return { result: "processed", action: "payment_failed" };
    }
    await finish("PROCESSED");
    return { result: "processed", action: "already_processed" };
  }

  // 5. The payment succeeded. Never trust the amount blindly.
  if (payment.amountCents !== event.amountCents || payment.currency !== event.currency) {
    await finish("FAILED", "Amount or currency does not match the payment");
    return { result: "ignored", reason: "amount mismatch" };
  }
  if (payment.status === "SUCCEEDED" || payment.status === "REFUNDED") {
    await finish("PROCESSED");
    return { result: "processed", action: "already_processed" };
  }

  // Customer paid but we cannot give the ticket: mark for refund.
  const refund = async (reason: string): Promise<WebhookOutcome> => {
    await sql.execute(`UPDATE "Payment" SET status = 'REFUNDED', "updatedAt" = ${ts(2)} WHERE id = $1`, [payment.id, nowIso]);
    await writeAudit(sql, nowIso, [
      {
        actorId: null,
        action: "PAYMENT_AUTO_REFUND",
        entityType: "Payment",
        entityId: payment.id,
        metadata: { bookingId: booking.id, reason },
      },
    ]);
    await finish("PROCESSED");
    return {
      result: "processed",
      action: "refund_required",
      refund: { providerPaymentId: event.providerPaymentId, amountCents: payment.amountCents },
    };
  };

  const markPaid = (action: string) =>
    sql
      .execute(`UPDATE "Payment" SET status = 'SUCCEEDED', "updatedAt" = ${ts(2)} WHERE id = $1`, [payment.id, nowIso])
      .then(() =>
        writeAudit(sql, nowIso, [
          { actorId: null, action: "PAYMENT_SUCCEEDED", entityType: "Payment", entityId: payment.id, metadata: { bookingId: booking.id } },
          { actorId: null, action, entityType: "Booking", entityId: booking.id },
        ]),
      );

  // Someone already paid this booking: this is a second charge.
  if (booking.status === "CONFIRMED") return refund("booking was already paid");

  // 5a. Normal case. Even if the hold time just ran out, the seats are still ours
  //     as long as nobody took them, so we keep the promise to a customer who paid.
  if (booking.status === "PENDING") {
    const counts = await sql.query<{ held: number; items: number }>(
      `SELECT (SELECT count(*)::int FROM "Seat" WHERE "currentBookingId" = $1 AND status = 'HELD') AS held,
              (SELECT count(*)::int FROM "BookingItem" WHERE "bookingId" = $1 AND "isActive" = true) AS items`,
      [booking.id],
    );
    const { held, items } = counts[0]!;
    if (held === 0 || held !== items) return refund("seats are no longer held");

    await confirmBooking(sql, booking.id, nowIso);
    await markPaid("BOOKING_CONFIRMED");
    await finish("PROCESSED");
    return { result: "processed", action: "confirmed" };
  }

  // 5b. The hold expired and the job released the seats. If they are all still free, take them back.
  if (booking.status === "EXPIRED") {
    const items = await sql.query<{ seatId: string }>(
      `SELECT "seatId" FROM "BookingItem" WHERE "bookingId" = $1 ORDER BY "seatId"`,
      [booking.id],
    );
    if (items.length === 0) return refund("booking has no seats");

    const seatIds = items.map((i) => i.seatId);
    const seats = await sql.query<{ id: string; status: string }>(
      `SELECT id, status::text AS status FROM "Seat" WHERE id IN (${marks(1, seatIds.length)}) ORDER BY id FOR UPDATE`,
      seatIds,
    );
    if (seats.length !== seatIds.length || seats.some((s) => s.status !== "AVAILABLE")) {
      return refund("seats were taken by someone else");
    }

    await sql.execute(`UPDATE "BookingItem" SET "isActive" = true WHERE "bookingId" = $1`, [booking.id]);
    const sold = await sql.execute(
      `UPDATE "Seat" SET status = 'SOLD', "holdExpiresAt" = NULL, "currentBookingId" = $1, version = version + 1
        WHERE status = 'AVAILABLE' AND id IN (${marks(2, seatIds.length)})`,
      [booking.id, ...seatIds],
    );
    if (sold !== seatIds.length) {
      throw AppError.conflict("SEAT_UNAVAILABLE", "Seats changed while confirming"); // rolls back; the retry refunds
    }
    await sql.execute(
      `UPDATE "Booking" SET status = 'CONFIRMED', "confirmedAt" = ${ts(2)}, "updatedAt" = ${ts(2)} WHERE id = $1`,
      [booking.id, nowIso],
    );
    await markPaid("BOOKING_RECONFIRMED_AFTER_EXPIRY");
    await finish("PROCESSED");
    return { result: "processed", action: "reconfirmed" };
  }

  // CANCELLED (or anything else): the customer changed their mind while paying. Give the money back.
  return refund(`booking is ${booking.status.toLowerCase()}`);
}

// ───────────── Helpers ─────────────

// PENDING -> CONFIRMED, and the held seats become SOLD.
async function confirmBooking(sql: Sql, bookingId: string, nowIso: string) {
  await sql.execute(
    `UPDATE "Booking" SET status = 'CONFIRMED', "confirmedAt" = ${ts(2)}, "updatedAt" = ${ts(2)} WHERE id = $1`,
    [bookingId, nowIso],
  );
  await sql.execute(
    `UPDATE "Seat" SET status = 'SOLD', "holdExpiresAt" = NULL, version = version + 1
      WHERE "currentBookingId" = $1 AND status = 'HELD'`,
    [bookingId],
  );
}