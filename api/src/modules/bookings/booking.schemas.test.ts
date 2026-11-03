import { describe, expect, it } from "vitest";
import { createBookingSchema, idempotencyHeaderSchema, listBookingsQuerySchema } from "./booking.schemas.js";

const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

describe("createBookingSchema", () => {
  it("accepts 1 to 6 seats", () => {
    expect(createBookingSchema.safeParse({ eventId: uuid(1), seatIds: [uuid(2)] }).success).toBe(true);
    const six = [2, 3, 4, 5, 6, 7].map(uuid);
    expect(createBookingSchema.safeParse({ eventId: uuid(1), seatIds: six }).success).toBe(true);
  });

  it("rejects 7 seats", () => {
    const seven = [2, 3, 4, 5, 6, 7, 8].map(uuid);
    expect(createBookingSchema.safeParse({ eventId: uuid(1), seatIds: seven }).success).toBe(false);
  });

  it("rejects an empty seat list", () => {
    expect(createBookingSchema.safeParse({ eventId: uuid(1), seatIds: [] }).success).toBe(false);
  });

  it("rejects duplicate seats", () => {
    expect(createBookingSchema.safeParse({ eventId: uuid(1), seatIds: [uuid(2), uuid(2)] }).success).toBe(false);
  });

  it("rejects ids that are not uuids", () => {
    expect(createBookingSchema.safeParse({ eventId: "x", seatIds: [uuid(2)] }).success).toBe(false);
  });
});

describe("idempotencyHeaderSchema", () => {
  it("accepts a uuid key", () => {
    expect(idempotencyHeaderSchema.safeParse({ "idempotency-key": "8f14e45f-ceea-4f6a-9d38-5b6f3c1f2a10" }).success).toBe(true);
  });

  it("rejects a missing key", () => {
    expect(idempotencyHeaderSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a too-short key", () => {
    expect(idempotencyHeaderSchema.safeParse({ "idempotency-key": "abc" }).success).toBe(false);
  });

  it("rejects spaces and odd characters", () => {
    expect(idempotencyHeaderSchema.safeParse({ "idempotency-key": "not a valid key!" }).success).toBe(false);
  });
});

describe("listBookingsQuerySchema", () => {
  it("defaults the limit to 20", () => {
    expect(listBookingsQuerySchema.parse({}).limit).toBe(20);
  });
});
