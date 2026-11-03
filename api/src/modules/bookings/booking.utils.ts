
// A PENDING booking whose time ran out is shown as EXPIRED right away,

import { constraintName, isRetryableTxError } from "../../lib/prisma-error.js";

// even if the background job has not cleaned it up yet.
export function presentBooking<T extends { status: string; expiresAt: Date }>(booking: T, now = new Date()) {
  const status = booking.status === "PENDING" && booking.expiresAt <= now ? "EXPIRED" : booking.status;
  return { ...booking, status };
}

// Deadlocks are rare but normal in a busy database: run the whole transaction again.
// Two requests with the same Idempotency-Key but different events can also clash once;
// on the second run the first booking is found and returned.
function shouldRetry(err: unknown) {
  return isRetryableTxError(err) || constraintName(err) === "Booking_userId_idempotencyKey_key";
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.random() * 20));
    }
  }
}
