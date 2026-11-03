import { z } from "zod";

export const MAX_SEATS_PER_BOOKING = 6;

export const createBookingSchema = z
  .object({
    eventId: z.uuid(),
    seatIds: z.array(z.uuid()).min(1).max(MAX_SEATS_PER_BOOKING),
  })
  .refine((d) => new Set(d.seatIds).size === d.seatIds.length, {
    message: "seatIds must be unique",
    path: ["seatIds"],
  });

// The client generates one key per "attempt to buy" (for example a UUID) and
// sends the SAME key again when it retries. Required on POST /bookings.
export const idempotencyHeaderSchema = z.object({
  "idempotency-key": z
    .string()
    .trim()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_\-:.]+$/, "Only letters, digits and _ - : . are allowed"),
});

export const bookingIdParamSchema = z.object({
  id: z.uuid(),
});

export const listBookingsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.uuid().optional(),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
