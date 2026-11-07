import { randomUUID } from "node:crypto";
import type { Sql } from "../lib/sql.js";
import { holdSeats } from "../modules/bookings/booking.core.js";
import { initiatePayment, processWebhookEvent } from "../modules/payments/payment.core.js";
import type { createTestDb } from "./pg-helpers.js";

type TestDb = ReturnType<typeof createTestDb>;

// Small building blocks for tests that need bookings in a certain state.
export function createScenarios(db: TestDb) {
  const { inTx } = db;

  // A PENDING booking (seats held).
  const book = async (userId: string, eventId: string, seatIds: string[]) =>
    (
      await inTx((sql) =>
        holdSeats(sql, { userId, eventId, seatIds, idempotencyKey: randomUUID(), holdMinutes: 15, now: new Date() }),
      )
    ).bookingId;

  // A PENDING booking with a payment that is waiting for the customer.
  const bookWithPayment = async (userId: string, eventId: string, seatIds: string[]) => {
    const bookingId = await book(userId, eventId, seatIds);
    const pay = await inTx((sql: Sql) =>
      initiatePayment(sql, {
        bookingId,
        userId,
        now: new Date(),
        providerName: "fake",
        createWithProvider: async () => ({ providerPaymentId: `fake_pay_${randomUUID()}`, checkout: {} }),
      }),
    );
    if (pay.kind !== "payment") throw new Error("expected a payment");
    return { bookingId, providerPaymentId: pay.providerPaymentId, amountCents: pay.amountCents };
  };

  const succeedEvent = (p: { providerPaymentId: string; amountCents: number }) => {
    const id = `evt_${randomUUID()}`;
    return { id, type: "payment.succeeded" as const, providerPaymentId: p.providerPaymentId, amountCents: p.amountCents, currency: "USD", raw: { id } };
  };

  const deliverSuccess = (p: { providerPaymentId: string; amountCents: number }) =>
    inTx((sql) => processWebhookEvent(sql, { event: succeedEvent(p), provider: "fake", now: new Date() }));

  // A CONFIRMED booking that was paid.
  const bookAndPay = async (userId: string, eventId: string, seatIds: string[]) => {
    const pending = await bookWithPayment(userId, eventId, seatIds);
    await deliverSuccess(pending);
    return pending;
  };

  return { book, bookWithPayment, bookAndPay, deliverSuccess, succeedEvent };
}