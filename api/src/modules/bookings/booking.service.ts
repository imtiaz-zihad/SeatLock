import { AppError } from "../../lib/errors.js";
import { toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { type PrismaTx, prismaSql } from "../../lib/sql.js";
import type { Actor } from "../../lib/types.js";
import { issueRefunds } from "../payments/payment.refunds.js";
import * as core from "./booking.core.js";
import * as repo from "./booking.repository.js";
import type { CreateBookingInput, ListBookingsQuery } from "./booking.schemas.js";
import { presentBooking, withRetry } from "./booking.utils.js";

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 };

// The fields the service itself needs from a booking row.
type BookingRow = { id: string; userId: string; status: string; expiresAt: Date };

function holdMinutes() {
  const minutes = Number(process.env.BOOKING_HOLD_MINUTES ?? 15);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 15;
}

async function loadOrThrow(id: string): Promise<BookingRow> {
  const booking: BookingRow | null = await repo.findById(id);
  if (!booking) throw AppError.notFound("Booking");
  return booking;
}

export async function createBooking(actor: Actor, idempotencyKey: string, input: CreateBookingInput) {
  const { bookingId, replayed } = await withRetry<core.HoldResult>(() =>
    prisma.$transaction(
      (tx: PrismaTx) =>
        core.holdSeats(prismaSql(tx), {
          userId: actor.id,
          eventId: input.eventId,
          seatIds: input.seatIds,
          idempotencyKey,
          holdMinutes: holdMinutes(),
          now: new Date(),
        }),
      TX_OPTIONS,
    ),
  );

  return { booking: presentBooking(await loadOrThrow(bookingId)), replayed };
}

// Your own bookings, newest first. Admins also use this for their own bookings.
export async function listMyBookings(actor: Actor, query: ListBookingsQuery) {
  const rows: BookingRow[] = await repo.listByUser(actor.id, query);
  const page = toPage(rows, query.limit);
  return { ...page, data: page.data.map((b) => presentBooking(b)) };
}

// Someone else's booking looks like it does not exist (admins can see all).
export async function getBooking(actor: Actor, id: string) {
  const booking = await loadOrThrow(id);
  if (booking.userId !== actor.id && actor.role !== "ADMIN") {
    throw AppError.notFound("Booking");
  }
  return presentBooking(booking);
}

// A confirmed booking can be cancelled until CANCELLATION_CUTOFF_HOURS before the event (default 24).
function cutoffHours() {
  const hours = Number(process.env.CANCELLATION_CUTOFF_HOURS ?? 24);
  return Number.isFinite(hours) && hours >= 0 ? Math.floor(hours) : 24;
}

export async function cancelBooking(actor: Actor, id: string) {
  const { refund } = await withRetry<core.CancelResult>(() =>
    prisma.$transaction(
      (tx: PrismaTx) =>
        core.cancelBooking(prismaSql(tx), { bookingId: id, actor, now: new Date(), cutoffHours: cutoffHours() }),
      TX_OPTIONS,
    ),
  );

  // The database is committed. Now return the money (never while holding locks).
  if (refund) await issueRefunds([refund]);

  return presentBooking(await loadOrThrow(id));
}

// Used by the background job. Returns how many bookings were expired.
export async function expireOverdueBookings(): Promise<number> {
  const batch = 100;
  let total = 0;

  for (;;) {
    const expired = await prisma.$transaction(
      (tx: PrismaTx) => core.expireDueBookings(prismaSql(tx), new Date().toISOString(), batch),
      TX_OPTIONS,
    );
    total += expired;
    if (expired < batch) return total;
  }
}