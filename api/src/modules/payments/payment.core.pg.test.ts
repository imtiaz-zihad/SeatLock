import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "../../lib/sql.js";
import { createTestDb } from "../../tests/pg-helpers.js";
import { cancelBooking, expireDueBookings, holdSeats } from "../bookings/booking.core.js";
import { withRetry } from "../bookings/booking.utils.js";
import { initiatePayment, processWebhookEvent, type WebhookOutcome } from "./payment.core.js";

// Runs the real payment SQL against a real PostgreSQL database.
// Skipped unless TEST_DATABASE_URL is set (use a SEPARATE test database).
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("payment core on a real database", () => {
  const db = createTestDb(url);
  const { q, inTx, race, raceTx, createUsers, createEvent, seatStatus } = db;

  // ---------- helpers ----------
  const book = async (userId: string, eventId: string, seatIds: string[]) =>
    (
      await inTx((sql) =>
        holdSeats(sql, { userId, eventId, seatIds, idempotencyKey: randomUUID(), holdMinutes: 15, now: new Date() }),
      )
    ).bookingId;

  let providerCalls = 0;
  const initiate = (userId: string, bookingId: string) => (sql: Sql) =>
    initiatePayment(sql, {
      bookingId,
      userId,
      now: new Date(),
      providerName: "fake",
      createWithProvider: async () => {
        providerCalls++;
        return { providerPaymentId: `fake_pay_${randomUUID()}`, checkout: { type: "fake" } };
      },
    });

  const startPayment = async (userId: string, bookingId: string) => {
    const r = await inTx(initiate(userId, bookingId));
    if (r.kind !== "payment") throw new Error("expected a payment");
    return r;
  };

  const eventFor = (
    type: "payment.succeeded" | "payment.failed",
    p: { providerPaymentId: string; amountCents: number; currency?: string },
    id = `evt_${randomUUID()}`,
  ) => ({
    id,
    type,
    providerPaymentId: p.providerPaymentId,
    amountCents: p.amountCents,
    currency: p.currency ?? "USD",
    raw: { id, type },
  });

  const deliverJob =
    (event: ReturnType<typeof eventFor>) =>
    (sql: Sql): Promise<WebhookOutcome> =>
      processWebhookEvent(sql, { event, provider: "fake", now: new Date() });

  const deliver = (event: ReturnType<typeof eventFor>) => inTx(deliverJob(event));

  const forceExpire = async (bookingId: string) => {
    await q(`UPDATE "Booking" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [bookingId]);
    await q(
      `UPDATE "Seat" SET "holdExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE "currentBookingId" = $1 AND status = 'HELD'`,
      [bookingId],
    );
  };

  const bookingStatus = async (id: string) =>
    (await q<{ status: string }>(`SELECT status::text AS status FROM "Booking" WHERE id = $1`, [id]))[0]!.status;
  const paymentStatus = async (providerPaymentId: string) =>
    (await q<{ status: string }>(`SELECT status::text AS status FROM "Payment" WHERE "providerPaymentId" = $1`, [providerPaymentId]))[0]!.status;
  const count = async (sql: string, params: unknown[] = []) => (await q(sql, params)).length;

  beforeAll(async () => {
    await q("SELECT 1");
  });
  beforeEach(async () => {
    providerCalls = 0;
    await db.reset();
  });
  afterAll(async () => {
    await db.close();
  });

  // ---------- starting a payment ----------
  it("creates an INITIATED payment for the booking total", async () => {
    const { eventId, seatIds } = await createEvent(2, { priceCents: 5000 });
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);

    const payment = await startPayment(user!, bookingId);

    expect(payment).toMatchObject({ status: "INITIATED", amountCents: 10000, currency: "USD", replayed: false });
    expect(payment.checkout).not.toBeNull();
    expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'PAYMENT_INITIATED'`)).toBe(1);
  });

  it("paying twice returns the same payment and does not call the provider again", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);

    const first = await startPayment(user!, bookingId);
    const second = await startPayment(user!, bookingId);

    expect(second.providerPaymentId).toBe(first.providerPaymentId);
    expect(second.replayed).toBe(true);
    expect(providerCalls).toBe(1);
    expect(await count(`SELECT 1 FROM "Payment"`)).toBe(1);
  });

  it("10 simultaneous 'pay' requests create exactly one payment", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);

    const results = await race(Array.from({ length: 10 }, () => initiate(user!, bookingId)));

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await count(`SELECT 1 FROM "Payment"`)).toBe(1);
    expect(providerCalls).toBe(1);
  });

  it("cannot pay for someone else's booking (404)", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [owner, stranger] = await createUsers(2);
    const bookingId = await book(owner!, eventId, seatIds);

    await expect(inTx(initiate(stranger!, bookingId))).rejects.toMatchObject({ status: 404 });
  });

  it("cannot pay for a cancelled booking (409 INVALID_STATE)", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    await inTx((sql) => cancelBooking(sql, { bookingId, actor: { id: user!, role: "USER" }, now: new Date() }));

    await expect(inTx(initiate(user!, bookingId))).rejects.toMatchObject({ status: 409, code: "INVALID_STATE" });
  });

  it("cannot pay after the hold expired (409 BOOKING_EXPIRED)", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    await forceExpire(bookingId);

    await expect(inTx(initiate(user!, bookingId))).rejects.toMatchObject({ status: 409, code: "BOOKING_EXPIRED" });
  });

  it("a free booking (total 0) is confirmed without any payment", async () => {
    const { eventId, seatIds } = await createEvent(1, { priceCents: 0 });
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);

    const result = await inTx(initiate(user!, bookingId));

    expect(result.kind).toBe("free");
    expect(await bookingStatus(bookingId)).toBe("CONFIRMED");
    expect(await seatStatus(seatIds[0]!)).toBe("SOLD");
    expect(await count(`SELECT 1 FROM "Payment"`)).toBe(0);
  });

  // ---------- webhook: success ----------
  it("a successful payment confirms the booking and sells the seats", async () => {
    const { eventId, seatIds } = await createEvent(2, { priceCents: 5000 });
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    const pay = await startPayment(user!, bookingId);

    const outcome = await deliver(eventFor("payment.succeeded", pay));

    expect(outcome).toEqual({ result: "processed", action: "confirmed" });
    expect(await bookingStatus(bookingId)).toBe("CONFIRMED");
    expect(await paymentStatus(pay.providerPaymentId)).toBe("SUCCEEDED");
    expect(await seatStatus(seatIds[0]!)).toBe("SOLD");
    expect(await seatStatus(seatIds[1]!)).toBe("SOLD");
    expect(await count(`SELECT 1 FROM "BookingItem" WHERE "bookingId" = $1 AND "isActive" = true`, [bookingId])).toBe(2);
    const [hook] = await q<{ status: string }>(`SELECT status::text AS status FROM "WebhookEvent"`);
    expect(hook!.status).toBe("PROCESSED");
    expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'BOOKING_CONFIRMED'`)).toBe(1);
  });

  it("the same event delivered twice is processed once", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    const pay = await startPayment(user!, bookingId);
    const event = eventFor("payment.succeeded", pay, "evt_fixed_1");

    const first = await deliver(event);
    const second = await deliver(event);

    expect(first).toMatchObject({ result: "processed", action: "confirmed" });
    expect(second).toEqual({ result: "duplicate" });
    expect(await count(`SELECT 1 FROM "WebhookEvent"`)).toBe(1);
    expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'BOOKING_CONFIRMED'`)).toBe(1);
  });

  it("10 identical webhooks at the same moment: one is processed, nine are duplicates", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    const pay = await startPayment(user!, bookingId);
    const event = eventFor("payment.succeeded", pay, "evt_parallel");

    const results = await race(Array.from({ length: 10 }, () => deliverJob(event)));

    const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    expect(outcomes.every((o) => o !== null)).toBe(true);
    expect(outcomes.filter((o) => o!.result === "processed")).toHaveLength(1);
    expect(outcomes.filter((o) => o!.result === "duplicate")).toHaveLength(9);
    expect(await bookingStatus(bookingId)).toBe("CONFIRMED");
    expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'BOOKING_CONFIRMED'`)).toBe(1);
  });

  it("a second event (different id) for an already paid payment changes nothing", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    const pay = await startPayment(user!, bookingId);
    await deliver(eventFor("payment.succeeded", pay));

    const again = await deliver(eventFor("payment.succeeded", pay));

    expect(again).toEqual({ result: "processed", action: "already_processed" });
    expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'BOOKING_CONFIRMED'`)).toBe(1);
  });

  // ---------- webhook: failure and bad input ----------
  it("a failed payment keeps the booking PENDING and the customer can pay again", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    const first = await startPayment(user!, bookingId);

    const outcome = await deliver(eventFor("payment.failed", first));

    expect(outcome).toEqual({ result: "processed", action: "payment_failed" });
    expect(await paymentStatus(first.providerPaymentId)).toBe("FAILED");
    expect(await bookingStatus(bookingId)).toBe("PENDING");
    expect(await seatStatus(seatIds[0]!)).toBe("HELD");

    const retry = await startPayment(user!, bookingId);
    expect(retry.providerPaymentId).not.toBe(first.providerPaymentId);
    expect(retry.replayed).toBe(false);
  });

  it("a wrong amount is rejected and nothing is confirmed", async () => {
    const { eventId, seatIds } = await createEvent(1, { priceCents: 5000 });
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    const pay = await startPayment(user!, bookingId);

    const outcome = await deliver(eventFor("payment.succeeded", { ...pay, amountCents: 1 }));

    expect(outcome).toEqual({ result: "ignored", reason: "amount mismatch" });
    expect(await bookingStatus(bookingId)).toBe("PENDING");
    const [hook] = await q<{ status: string }>(`SELECT status::text AS status FROM "WebhookEvent"`);
    expect(hook!.status).toBe("FAILED");
  });

  it("an event for an unknown payment is recorded and ignored (no crash, no retry loop)", async () => {
    const outcome = await deliver(eventFor("payment.succeeded", { providerPaymentId: "nope", amountCents: 100 }));

    expect(outcome).toEqual({ result: "ignored", reason: "unknown payment" });
    expect(await count(`SELECT 1 FROM "WebhookEvent"`)).toBe(1);
  });

  // ---------- late payments ----------
  it("payment that arrives just after the hold time still confirms if the seats were not taken", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    const pay = await startPayment(user!, bookingId);
    await forceExpire(bookingId); // time ran out, the cleanup job has NOT run

    const outcome = await deliver(eventFor("payment.succeeded", pay));

    expect(outcome).toEqual({ result: "processed", action: "confirmed" });
    expect(await bookingStatus(bookingId)).toBe("CONFIRMED");
    expect(await seatStatus(seatIds[0]!)).toBe("SOLD");
  });

  it("payment after the job expired the booking: seats still free, so the booking is restored", async () => {
    const { eventId, seatIds } = await createEvent(2);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    const pay = await startPayment(user!, bookingId);
    await forceExpire(bookingId);
    await inTx((sql) => expireDueBookings(sql, new Date().toISOString()));
    expect(await bookingStatus(bookingId)).toBe("EXPIRED");
    expect(await seatStatus(seatIds[0]!)).toBe("AVAILABLE");

    const outcome = await deliver(eventFor("payment.succeeded", pay));

    expect(outcome).toEqual({ result: "processed", action: "reconfirmed" });
    expect(await bookingStatus(bookingId)).toBe("CONFIRMED");
    expect(await seatStatus(seatIds[0]!)).toBe("SOLD");
    expect(await seatStatus(seatIds[1]!)).toBe("SOLD");
    expect(await count(`SELECT 1 FROM "BookingItem" WHERE "bookingId" = $1 AND "isActive" = true`, [bookingId])).toBe(2);
  });

  it("payment after expiry when someone else took the seat: automatic refund, other booking untouched", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [alice, bob] = await createUsers(2);
    const aliceBooking = await book(alice!, eventId, seatIds);
    const pay = await startPayment(alice!, aliceBooking);
    await forceExpire(aliceBooking);
    await inTx((sql) => expireDueBookings(sql, new Date().toISOString()));
    const bobBooking = await book(bob!, eventId, seatIds); // Bob grabs the seat

    const outcome = await deliver(eventFor("payment.succeeded", pay));

    expect(outcome).toMatchObject({
      result: "processed",
      action: "refund_required",
      refund: { providerPaymentId: pay.providerPaymentId, amountCents: 5000 },
    });
    expect(await paymentStatus(pay.providerPaymentId)).toBe("REFUNDED");
    expect(await bookingStatus(aliceBooking)).toBe("EXPIRED");
    expect(await bookingStatus(bobBooking)).toBe("PENDING");
    expect(await seatStatus(seatIds[0]!)).toBe("HELD");
    expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'PAYMENT_AUTO_REFUND'`)).toBe(1);
  });

  it("payment for a cancelled booking is refunded", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    const pay = await startPayment(user!, bookingId);
    await inTx((sql) => cancelBooking(sql, { bookingId, actor: { id: user!, role: "USER" }, now: new Date() }));

    const outcome = await deliver(eventFor("payment.succeeded", pay));

    expect(outcome).toMatchObject({ result: "processed", action: "refund_required" });
    expect(await bookingStatus(bookingId)).toBe("CANCELLED");
    expect(await seatStatus(seatIds[0]!)).toBe("AVAILABLE");
  });

  it("a second successful payment for an already paid booking is refunded (no double charge kept)", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    const first = await startPayment(user!, bookingId);
    await deliver(eventFor("payment.succeeded", first));
    // a second payment row (as if the customer opened a second checkout)
    await q(
      `INSERT INTO "Payment" (id, "bookingId", provider, "providerPaymentId", status, "amountCents", currency, "updatedAt")
       VALUES ($1, $2, 'fake', 'fake_second', 'INITIATED', 5000, 'USD', now())`,
      [randomUUID(), bookingId],
    );

    const outcome = await deliver(eventFor("payment.succeeded", { providerPaymentId: "fake_second", amountCents: 5000 }));

    expect(outcome).toMatchObject({ result: "processed", action: "refund_required" });
    expect(await paymentStatus("fake_second")).toBe("REFUNDED");
    expect(await paymentStatus(first.providerPaymentId)).toBe("SUCCEEDED");
  });

  // ---------- the hard race ----------
  it("RACE: payment arrives at the same moment another user grabs the expired seat: never both", async () => {
    const tally = { paidWins: 0, otherWins: 0 };

    for (let round = 0; round < 8; round++) {
      await db.reset();
      const { eventId, seatIds } = await createEvent(1);
      const [alice, bob] = await createUsers(2);
      const aliceBooking = await book(alice!, eventId, seatIds);
      const pay = await startPayment(alice!, aliceBooking);
      await forceExpire(aliceBooking); // Alice's hold ran out, but she is paying right now

      const [webhook, bobHold] = await raceTx<unknown>([
        () => withRetry(() => inTx(deliverJob(eventFor("payment.succeeded", pay)))),
        () =>
          withRetry(() =>
            inTx((sql) =>
              holdSeats(sql, { userId: bob!, eventId, seatIds, idempotencyKey: randomUUID(), holdMinutes: 15, now: new Date() }),
            ),
          ),
      ]);

      // the webhook itself must never fail
      expect(webhook!.status).toBe("fulfilled");
      const outcome = (webhook as PromiseFulfilledResult<WebhookOutcome>).value;
      expect(outcome.result).toBe("processed");

      const seat = (await q<{ status: string; currentBookingId: string | null }>(
        `SELECT status::text AS status, "currentBookingId" FROM "Seat" WHERE id = $1`,
        [seatIds[0]],
      ))[0]!;
      const activeItems = await count(`SELECT 1 FROM "BookingItem" WHERE "seatId" = $1 AND "isActive" = true`, [seatIds[0]]);
      expect(activeItems).toBe(1); // the seat belongs to exactly one booking

      if (outcome.result === "processed" && outcome.action === "confirmed") {
        // Alice paid and kept the seat: Bob must have been refused
        tally.paidWins++;
        expect(bobHold!.status).toBe("rejected");
        expect((bobHold as PromiseRejectedResult).reason).toMatchObject({ code: "SEAT_UNAVAILABLE" });
        expect(await bookingStatus(aliceBooking)).toBe("CONFIRMED");
        expect(seat).toMatchObject({ status: "SOLD", currentBookingId: aliceBooking });
      } else {
        // Bob got the seat first: Alice must be refunded
        tally.otherWins++;
        expect(outcome).toMatchObject({ action: "refund_required" });
        expect(bobHold!.status).toBe("fulfilled");
        expect(await paymentStatus(pay.providerPaymentId)).toBe("REFUNDED");
        expect(await bookingStatus(aliceBooking)).toBe("EXPIRED");
        expect(seat.status).toBe("HELD");
        expect(seat.currentBookingId).not.toBe(aliceBooking);
      }
    }

    // Both orders are legal. This only records which ones happened in this run.
    console.log("race outcomes over 8 rounds:", tally);
    expect(tally.paidWins + tally.otherWins).toBe(8);
  }, 60_000);

  // ---------- database safety nets ----------
  it("DB safety net: only one INITIATED payment per booking", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    await startPayment(user!, bookingId);

    await expect(
      q(
        `INSERT INTO "Payment" (id, "bookingId", provider, "providerPaymentId", status, "amountCents", currency, "updatedAt")
         VALUES ($1, $2, 'fake', $3, 'INITIATED', 5000, 'USD', now())`,
        [randomUUID(), bookingId, `x_${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "Payment_one_initiated_per_booking" });
  });

  it("DB safety net: only one SUCCEEDED payment per booking", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const bookingId = await book(user!, eventId, seatIds);
    const pay = await startPayment(user!, bookingId);
    await deliver(eventFor("payment.succeeded", pay));

    await expect(
      q(
        `INSERT INTO "Payment" (id, "bookingId", provider, "providerPaymentId", status, "amountCents", currency, "updatedAt")
         VALUES ($1, $2, 'fake', $3, 'SUCCEEDED', 5000, 'USD', now())`,
        [randomUUID(), bookingId, `y_${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "Payment_one_succeeded_per_booking" });
  });
});