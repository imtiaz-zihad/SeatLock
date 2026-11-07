import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeAudit } from "../../lib/audit.js";
import { createTestDb } from "../../tests/pg-helpers.js";
import { createScenarios } from "../../tests/pg-scenarios.js";
import { getStats, listAuditLogs } from "../admin/admin.core.js";
import { cancelBooking, expireDueBookings, holdSeats } from "../bookings/booking.core.js";
import { withRetry } from "../bookings/booking.utils.js";
import { initiatePayment, processWebhookEvent } from "../payments/payment.core.js";
import { cancelEventWithRefunds } from "./cancellation.core.js";

// Real PostgreSQL. Skipped unless TEST_DATABASE_URL is set (use a SEPARATE test database).
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("cancellations, refunds and admin reports on a real database", () => {
  const db = createTestDb(url);
  const { q, inTx, raceTx, race, createUsers, createEvent, seatStatus } = db;
  const { book, bookWithPayment, bookAndPay, deliverSuccess } = createScenarios(db);

  const owner = (id: string, role = "USER") => ({ id, role });
  const cancelAs = (bookingId: string, actor: { id: string; role: string }, cutoffHours?: number) =>
    inTx((sql) => cancelBooking(sql, { bookingId, actor, now: new Date(), cutoffHours }));
  const cancelEvent = (eventId: string, actorId: string) =>
    inTx((sql) => cancelEventWithRefunds(sql, { eventId, actorId, now: new Date() }));

  const bookingStatus = async (id: string) =>
    (await q<{ status: string }>(`SELECT status::text AS status FROM "Booking" WHERE id = $1`, [id]))[0]!.status;
  const paymentStatus = async (providerPaymentId: string) =>
    (await q<{ status: string }>(`SELECT status::text AS status FROM "Payment" WHERE "providerPaymentId" = $1`, [providerPaymentId]))[0]!.status;
  const eventStatus = async (id: string) =>
    (await q<{ status: string }>(`SELECT status::text AS status FROM "Event" WHERE id = $1`, [id]))[0]!.status;
  const count = async (sql: string, params: unknown[] = []) => (await q(sql, params)).length;
  const activeItems = (eventId: string) =>
    count(`SELECT 1 FROM "BookingItem" i JOIN "Booking" b ON b.id = i."bookingId" WHERE b."eventId" = $1 AND i."isActive" = true`, [eventId]);

  const forceExpire = async (bookingId: string) => {
    await q(`UPDATE "Booking" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [bookingId]);
    await q(`UPDATE "Seat" SET "holdExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE "currentBookingId" = $1 AND status = 'HELD'`, [bookingId]);
  };

  beforeAll(async () => {
    await q("SELECT 1");
  });
  beforeEach(async () => {
    await db.reset();
  });
  afterAll(async () => {
    await db.close();
  });

  // ═════════════ cancel a confirmed booking ═════════════
  describe("cancel a confirmed booking", () => {
    it("refunds a paid booking, frees the seats, and the seats can be bought again", async () => {
      const { eventId, seatIds } = await createEvent(2, { priceCents: 5000 });
      const [alice, bob] = await createUsers(2);
      const { bookingId, providerPaymentId } = await bookAndPay(alice!, eventId, seatIds);
      expect(await seatStatus(seatIds[0]!)).toBe("SOLD");

      const result = await cancelAs(bookingId, owner(alice!));

      expect(result.refund).toEqual({ providerPaymentId, amountCents: 10000 });
      expect(await bookingStatus(bookingId)).toBe("REFUNDED");
      expect(await paymentStatus(providerPaymentId)).toBe("REFUNDED");
      expect(await seatStatus(seatIds[0]!)).toBe("AVAILABLE");
      expect(await seatStatus(seatIds[1]!)).toBe("AVAILABLE");
      expect(await count(`SELECT 1 FROM "BookingItem" WHERE "bookingId" = $1 AND "isActive" = true`, [bookingId])).toBe(0);
      expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'BOOKING_CANCELLED' AND "entityId" = $1`, [bookingId])).toBe(1);
      expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'PAYMENT_REFUNDED'`)).toBe(1);

      // someone else can now buy the same seats
      await expect(book(bob!, eventId, seatIds)).resolves.toBeTruthy();
    });

    it("refuses inside the 24 hour window (event starts in 2 hours) and changes nothing", async () => {
      const { eventId, seatIds } = await createEvent(1, { startsInHours: 2 });
      const [alice] = await createUsers(1);
      const { bookingId, providerPaymentId } = await bookAndPay(alice!, eventId, seatIds);

      await expect(cancelAs(bookingId, owner(alice!))).rejects.toMatchObject({
        status: 409,
        code: "CANCELLATION_WINDOW_CLOSED",
      });

      expect(await bookingStatus(bookingId)).toBe("CONFIRMED");
      expect(await paymentStatus(providerPaymentId)).toBe("SUCCEEDED");
      expect(await seatStatus(seatIds[0]!)).toBe("SOLD");
    });

    it("an admin can cancel inside the window", async () => {
      const { eventId, seatIds } = await createEvent(1, { startsInHours: 2 });
      const [alice, admin] = await createUsers(2);
      const { bookingId, providerPaymentId } = await bookAndPay(alice!, eventId, seatIds);

      const result = await cancelAs(bookingId, owner(admin!, "ADMIN"));

      expect(result.refund?.providerPaymentId).toBe(providerPaymentId);
      expect(await bookingStatus(bookingId)).toBe("REFUNDED");
    });

    it("the cutoff is exact: 25 hours before is allowed, 23 hours before is not (24 hour rule)", async () => {
      const far = await createEvent(1, { startsInHours: 25 });
      const near = await createEvent(1, { startsInHours: 23 });
      const [u1, u2] = await createUsers(2);
      const farBooking = await bookAndPay(u1!, far.eventId, far.seatIds);
      const nearBooking = await bookAndPay(u2!, near.eventId, near.seatIds);

      await expect(cancelAs(farBooking.bookingId, owner(u1!), 24)).resolves.toBeTruthy();
      await expect(cancelAs(nearBooking.bookingId, owner(u2!), 24)).rejects.toMatchObject({
        code: "CANCELLATION_WINDOW_CLOSED",
      });
    });

    it("a free confirmed booking is CANCELLED and nothing needs refunding", async () => {
      const { eventId, seatIds } = await createEvent(1, { priceCents: 0 });
      const [alice] = await createUsers(1);
      const bookingId = await book(alice!, eventId, seatIds);
      await inTx((sql) =>
        initiatePayment(sql, {
          bookingId,
          userId: alice!,
          now: new Date(),
          providerName: "fake",
          createWithProvider: async () => ({ providerPaymentId: "unused", checkout: {} }),
        }),
      );
      expect(await bookingStatus(bookingId)).toBe("CONFIRMED");

      const result = await cancelAs(bookingId, owner(alice!));

      expect(result.refund).toBeNull();
      expect(await bookingStatus(bookingId)).toBe("CANCELLED");
      expect(await seatStatus(seatIds[0]!)).toBe("AVAILABLE");
    });

    it("a stranger sees 404, and cancelling a refunded booking again is 409", async () => {
      const { eventId, seatIds } = await createEvent(1);
      const [alice, mallory] = await createUsers(2);
      const { bookingId } = await bookAndPay(alice!, eventId, seatIds);

      await expect(cancelAs(bookingId, owner(mallory!))).rejects.toMatchObject({ status: 404 });
      await cancelAs(bookingId, owner(alice!));
      await expect(cancelAs(bookingId, owner(alice!))).rejects.toMatchObject({ status: 409, code: "INVALID_STATE" });
    });

    it("10 simultaneous cancels of the same booking: one wins and the money is refunded exactly once", async () => {
      const { eventId, seatIds } = await createEvent(1);
      const [alice] = await createUsers(1);
      const { bookingId, providerPaymentId } = await bookAndPay(alice!, eventId, seatIds);

      const results = await race(
        Array.from({ length: 10 }, () => (sql) => cancelBooking(sql, { bookingId, actor: owner(alice!), now: new Date() })),
      );

      const winners = results.filter((r) => r.status === "fulfilled");
      expect(winners).toHaveLength(1);
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) {
        expect(r.reason).toMatchObject({ status: 409, code: "INVALID_STATE" });
      }
      expect(await paymentStatus(providerPaymentId)).toBe("REFUNDED");
      expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'PAYMENT_REFUNDED'`)).toBe(1);
    });
  });

  // ═════════════ cancel a whole event ═════════════
  describe("cancel a whole event", () => {
    it("refunds paid bookings, cancels pending ones, and leaves finished ones alone", async () => {
      const { eventId, seatIds } = await createEvent(6, { priceCents: 5000 });
      const [a, b, c, d, e, organizer] = await createUsers(6);

      const paidA = await bookAndPay(a!, eventId, [seatIds[0]!]);
      const paidB = await bookAndPay(b!, eventId, [seatIds[1]!]);
      const pendingC = await bookWithPayment(c!, eventId, [seatIds[2]!]); // still waiting to pay
      const expiredD = await book(d!, eventId, [seatIds[3]!]);
      await forceExpire(expiredD);
      await inTx((sql) => expireDueBookings(sql, new Date().toISOString()));
      const cancelledE = await book(e!, eventId, [seatIds[4]!]);
      await cancelAs(cancelledE, owner(e!));

      const result = await cancelEvent(eventId, organizer!);

      expect(result.bookingsRefunded).toBe(2);
      expect(result.bookingsCancelled).toBe(1);
      expect(result.refunds).toHaveLength(2);
      expect(result.refunds).toEqual(
        expect.arrayContaining([
          { providerPaymentId: paidA.providerPaymentId, amountCents: 5000 },
          { providerPaymentId: paidB.providerPaymentId, amountCents: 5000 },
        ]),
      );

      expect(await eventStatus(eventId)).toBe("CANCELLED");
      expect(await bookingStatus(paidA.bookingId)).toBe("REFUNDED");
      expect(await bookingStatus(paidB.bookingId)).toBe("REFUNDED");
      expect(await bookingStatus(pendingC.bookingId)).toBe("CANCELLED");
      expect(await bookingStatus(expiredD)).toBe("EXPIRED"); // history is not rewritten
      expect(await bookingStatus(cancelledE)).toBe("CANCELLED");
      expect(await paymentStatus(paidA.providerPaymentId)).toBe("REFUNDED");
      expect(await paymentStatus(paidB.providerPaymentId)).toBe("REFUNDED");
      for (const id of seatIds) expect(await seatStatus(id)).toBe("AVAILABLE");
      expect(await activeItems(eventId)).toBe(0);
      expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'EVENT_CANCELLED'`)).toBe(1);
      expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'PAYMENT_REFUNDED'`)).toBe(2);
    });

    it("free bookings are cancelled without any refund", async () => {
      const { eventId, seatIds } = await createEvent(1, { priceCents: 0 });
      const [user, organizer] = await createUsers(2);
      const bookingId = await book(user!, eventId, seatIds);
      await inTx((sql) =>
        initiatePayment(sql, {
          bookingId,
          userId: user!,
          now: new Date(),
          providerName: "fake",
          createWithProvider: async () => ({ providerPaymentId: "unused", checkout: {} }),
        }),
      );

      const result = await cancelEvent(eventId, organizer!);

      expect(result).toMatchObject({ bookingsRefunded: 0, bookingsCancelled: 1, refunds: [] });
      expect(await bookingStatus(bookingId)).toBe("CANCELLED");
    });

    it("an event with no bookings (a draft) cancels cleanly, and cancelling twice is a 409", async () => {
      const { eventId } = await createEvent(2, { status: "DRAFT" });
      const [organizer] = await createUsers(1);

      const result = await cancelEvent(eventId, organizer!);
      expect(result).toEqual({ bookingsRefunded: 0, bookingsCancelled: 0, refunds: [] });

      await expect(cancelEvent(eventId, organizer!)).rejects.toMatchObject({ status: 409, code: "INVALID_STATE" });
    });

    it("an unknown event is a 404", async () => {
      const [organizer] = await createUsers(1);
      await expect(cancelEvent(randomUUID(), organizer!)).rejects.toMatchObject({ status: 404 });
    });

    it("afterwards nobody can book it, and a late payment is refunded", async () => {
      const { eventId, seatIds } = await createEvent(2);
      const [a, b, organizer] = await createUsers(3);
      const pending = await bookWithPayment(a!, eventId, [seatIds[0]!]);
      await cancelEvent(eventId, organizer!);

      await expect(book(b!, eventId, [seatIds[1]!])).rejects.toMatchObject({ code: "EVENT_NOT_BOOKABLE" });

      // the customer was still paying when the event was cancelled
      const late = await deliverSuccess(pending);
      expect(late).toMatchObject({ result: "processed", action: "refund_required" });
      expect(await paymentStatus(pending.providerPaymentId)).toBe("REFUNDED");
      expect(await seatStatus(seatIds[0]!)).toBe("AVAILABLE");
    });

    it("a big event: 300 paid bookings are refunded in one transaction", async () => {
      const { eventId, tierId, seatIds } = await createEvent(300, { priceCents: 2500 });
      const [organizer] = await createUsers(1);
      const users = await createUsers(300);

      // build 300 confirmed, paid bookings directly (faster than 300 booking + payment flows)
      for (let from = 0; from < 300; from += 25) {
        await Promise.all(
          users.slice(from, from + 25).map(async (userId, i) => {
            const n = from + i;
            const bookingId = randomUUID();
            await q(
              `INSERT INTO "Booking" (id, "userId", "eventId", status, "totalCents", currency, "idempotencyKey", "expiresAt", "confirmedAt", "updatedAt")
               VALUES ($1, $2, $3, 'CONFIRMED', 2500, 'USD', $4, now(), now(), now())`,
              [bookingId, userId, eventId, `bulk-${n}`],
            );
            await q(`INSERT INTO "BookingItem" (id, "bookingId", "seatId", "priceCents", "isActive") VALUES ($1, $2, $3, 2500, true)`, [randomUUID(), bookingId, seatIds[n]]);
            await q(
              `INSERT INTO "Payment" (id, "bookingId", provider, "providerPaymentId", status, "amountCents", currency, "updatedAt")
               VALUES ($1, $2, 'fake', $3, 'SUCCEEDED', 2500, 'USD', now())`,
              [randomUUID(), bookingId, `bulk_pay_${n}`],
            );
            await q(`UPDATE "Seat" SET status = 'SOLD', "currentBookingId" = $2 WHERE id = $1`, [seatIds[n], bookingId]);
          }),
        );
      }
      expect(tierId).toBeTruthy();

      const started = Date.now();
      const result = await cancelEvent(eventId, organizer!);
      const seconds = (Date.now() - started) / 1000;

      expect(result.bookingsRefunded).toBe(300);
      expect(result.refunds).toHaveLength(300);
      expect(new Set(result.refunds.map((r) => r.providerPaymentId)).size).toBe(300);
      expect(await count(`SELECT 1 FROM "Payment" WHERE status = 'REFUNDED'`)).toBe(300);
      expect(await count(`SELECT 1 FROM "Seat" WHERE "eventId" = $1 AND status <> 'AVAILABLE'`, [eventId])).toBe(0);
      expect(await count(`SELECT 1 FROM "AuditLog" WHERE action = 'PAYMENT_REFUNDED'`)).toBe(300);
      expect(seconds).toBeLessThan(15);
      console.log(`event cancel with 300 refunds took ${seconds.toFixed(2)}s`);
    }, 90_000);

    it("RACE: cancelling the event while people are booking: nobody keeps a seat of a cancelled event", async () => {
      const outcomes = { bookedFirst: 0, tooLate: 0 };

      for (let round = 0; round < 6; round++) {
        await db.reset();
        const { eventId, seatIds } = await createEvent(3);
        const [organizer, u1, u2, u3] = await createUsers(4);
        const hold = (userId: string, seat: string) => () =>
          withRetry(() =>
            inTx((sql) =>
              holdSeats(sql, { userId, eventId, seatIds: [seat], idempotencyKey: randomUUID(), holdMinutes: 15, now: new Date() }),
            ),
          );

        const results = await raceTx<unknown>([
          () => withRetry(() => cancelEvent(eventId, organizer!)),
          hold(u1!, seatIds[0]!),
          hold(u2!, seatIds[1]!),
          hold(u3!, seatIds[2]!),
        ]);

        expect(results[0]!.status).toBe("fulfilled"); // the cancel itself never fails
        for (const r of results.slice(1)) {
          if (r.status === "rejected") {
            expect(r.reason).toMatchObject({ code: "EVENT_NOT_BOOKABLE" });
            outcomes.tooLate++;
          } else {
            outcomes.bookedFirst++;
          }
        }

        // whoever won the race: in the end the event is cancelled and nothing is held or active
        expect(await eventStatus(eventId)).toBe("CANCELLED");
        expect(await activeItems(eventId)).toBe(0);
        expect(await count(`SELECT 1 FROM "Seat" WHERE "eventId" = $1 AND status <> 'AVAILABLE'`, [eventId])).toBe(0);
        expect(await count(`SELECT 1 FROM "Booking" WHERE "eventId" = $1 AND status = 'PENDING'`, [eventId])).toBe(0);
      }
      console.log("event cancel vs booking race:", outcomes);
    }, 60_000);

    it("RACE: cancelling the event while a payment arrives: the money is refunded exactly once, never kept", async () => {
      const tally = { paidFirst: 0, cancelledFirst: 0 };

      for (let round = 0; round < 6; round++) {
        await db.reset();
        const { eventId, seatIds } = await createEvent(1, { priceCents: 5000 });
        const [alice, organizer] = await createUsers(2);
        const pending = await bookWithPayment(alice!, eventId, seatIds);

        const [cancelResult, webhookResult] = await raceTx<unknown>([
          () => withRetry(() => cancelEvent(eventId, organizer!)),
          () =>
            withRetry(() =>
              inTx((sql) =>
                processWebhookEvent(sql, {
                  event: {
                    id: `evt_${randomUUID()}`,
                    type: "payment.succeeded",
                    providerPaymentId: pending.providerPaymentId,
                    amountCents: pending.amountCents,
                    currency: "USD",
                    raw: {},
                  },
                  provider: "fake",
                  now: new Date(),
                }),
              ),
            ),
        ]);

        expect(cancelResult!.status).toBe("fulfilled");
        expect(webhookResult!.status).toBe("fulfilled");
        const cancelled = (cancelResult as PromiseFulfilledResult<Awaited<ReturnType<typeof cancelEvent>>>).value;
        const webhook = (webhookResult as PromiseFulfilledResult<Awaited<ReturnType<typeof processWebhookEvent>>>).value;

        // exactly ONE refund request in total: either from the event cancel or from the webhook
        const fromWebhook = webhook.result === "processed" && webhook.refund ? 1 : 0;
        expect(cancelled.refunds.length + fromWebhook).toBe(1);
        if (fromWebhook === 1) tally.cancelledFirst++;
        else tally.paidFirst++;

        expect(await paymentStatus(pending.providerPaymentId)).toBe("REFUNDED");
        expect(["REFUNDED", "CANCELLED"]).toContain(await bookingStatus(pending.bookingId));
        expect(await seatStatus(seatIds[0]!)).toBe("AVAILABLE");
        expect(await activeItems(eventId)).toBe(0);
      }
      console.log("event cancel vs payment race:", tally);
    }, 60_000);
  });

  // ═════════════ admin reports ═════════════
  describe("admin reports", () => {
    it("stats count bookings, seats, events and money correctly", async () => {
      const { eventId, seatIds } = await createEvent(5, { priceCents: 5000 });
      await createEvent(0, { status: "DRAFT" });
      const [a, b, c, d, f] = await createUsers(5);

      await bookAndPay(a!, eventId, [seatIds[0]!]); // CONFIRMED, paid 5000
      const refundedB = await bookAndPay(b!, eventId, [seatIds[1]!]);
      await cancelAs(refundedB.bookingId, owner(b!)); // REFUNDED, 5000 back
      await book(c!, eventId, [seatIds[2]!]); // PENDING, live hold
      const expiredD = await book(d!, eventId, [seatIds[3]!]);
      await forceExpire(expiredD);
      await inTx((sql) => expireDueBookings(sql, new Date().toISOString())); // EXPIRED
      const staleF = await book(f!, eventId, [seatIds[4]!]);
      await forceExpire(staleF); // PENDING, but the hold already ran out (job has not run)

      const stats = await inTx((sql) => getStats(sql, new Date().toISOString()));

      expect(stats.bookings).toEqual({ PENDING: 2, CONFIRMED: 1, EXPIRED: 1, CANCELLED: 0, REFUNDED: 1 });
      expect(stats.seats).toEqual({ total: 5, available: 3, held: 1, sold: 1 }); // the stale hold counts as available
      expect(stats.events).toMatchObject({ PUBLISHED: 1, DRAFT: 1, CANCELLED: 0 });
      expect(stats.money).toEqual([{ currency: "USD", paidCents: 5000, refundedCents: 5000, netCents: 5000 }]);
      expect(stats.rates).toEqual({ holdExpiryRate: 0.2, refundRate: 0.5 });
    });

    it("stats on an empty database are all zeros (no divide by zero)", async () => {
      const stats = await inTx((sql) => getStats(sql, new Date().toISOString()));

      expect(stats.bookings).toEqual({ PENDING: 0, CONFIRMED: 0, EXPIRED: 0, CANCELLED: 0, REFUNDED: 0 });
      expect(stats.seats).toEqual({ total: 0, available: 0, held: 0, sold: 0 });
      expect(stats.money).toEqual([]);
      expect(stats.rates).toEqual({ holdExpiryRate: 0, refundRate: 0 });
    });

    it("audit logs: newest first, paged with a cursor, no row twice, even when many share one timestamp", async () => {
      const now = new Date().toISOString();
      await inTx((sql) =>
        writeAudit(
          sql,
          now,
          Array.from({ length: 25 }, (_, i) => ({
            actorId: null,
            action: i % 2 === 0 ? "BOOKING_CREATED" : "PAYMENT_FAILED",
            entityType: i % 2 === 0 ? "Booking" : "Payment",
            entityId: `entity-${i}`,
          })),
        ),
      );

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const rows = await inTx((sql) => listAuditLogs(sql, { limit: 10, cursor }));
        const shown = rows.slice(0, 10);
        seen.push(...shown.map((r) => r.id));
        if (rows.length <= 10) break;
        cursor = shown.at(-1)!.id;
      }

      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25); // nothing repeated, nothing missing
    });

    it("audit logs: newest first by time, and filters work", async () => {
      const t0 = Date.now();
      for (let i = 0; i < 3; i++) {
        await inTx((sql) =>
          writeAudit(sql, new Date(t0 + i * 1000).toISOString(), [
            { actorId: null, action: "EVENT_CANCELLED", entityType: "Event", entityId: `evt-${i}` },
          ]),
        );
      }
      await inTx((sql) =>
        writeAudit(sql, new Date(t0 + 5000).toISOString(), [
          { actorId: null, action: "PAYMENT_FAILED", entityType: "Payment", entityId: "pay-1" },
        ]),
      );

      const all = await inTx((sql) => listAuditLogs(sql, { limit: 10 }));
      expect(all.map((r) => r.entityId)).toEqual(["pay-1", "evt-2", "evt-1", "evt-0"]);

      const events = await inTx((sql) => listAuditLogs(sql, { limit: 10, entityType: "Event" }));
      expect(events.map((r) => r.entityId)).toEqual(["evt-2", "evt-1", "evt-0"]);

      const one = await inTx((sql) => listAuditLogs(sql, { limit: 10, entityId: "pay-1", action: "PAYMENT_FAILED" }));
      expect(one).toHaveLength(1);
    });

    it("audit logs: an unknown cursor returns nothing", async () => {
      await inTx((sql) => writeAudit(sql, new Date().toISOString(), [{ actorId: null, action: "X", entityType: "Event", entityId: "e" }]));
      const rows = await inTx((sql) => listAuditLogs(sql, { limit: 10, cursor: randomUUID() }));
      expect(rows).toEqual([]);
    });
  });
});