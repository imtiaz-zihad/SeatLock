import { prisma } from "../../lib/prisma.js";
import { type PrismaTx, prismaSql } from "../../lib/sql.js";
import { withRetry } from "../bookings/booking.utils.js";
import { issueRefunds } from "../payments/payment.refunds.js";
import * as core from "./cancellation.core.js";

// Big events: allow the transaction more time than the default.
const TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

export type EventCancellationSummary = {
  bookingsRefunded: number;
  bookingsCancelled: number;
  refundCallsFailed: number;
};

// Called by the event service after it checked permissions.
export async function cancelEventAndRefund(eventId: string, actorId: string): Promise<EventCancellationSummary> {
  const result = await withRetry<core.EventCancelResult>(() =>
    prisma.$transaction(
      (tx: PrismaTx) => core.cancelEventWithRefunds(prismaSql(tx), { eventId, actorId, now: new Date() }),
      TX_OPTIONS,
    ),
  );

  // The database is committed. Now tell the payment provider to return the money.
  const { failed } = await issueRefunds(result.refunds);

  return {
    bookingsRefunded: result.bookingsRefunded,
    bookingsCancelled: result.bookingsCancelled,
    refundCallsFailed: failed,
  };
}