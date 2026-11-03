import { describe, expect, it } from "vitest";
import { presentBooking, withRetry } from "./booking.utils.js";

const minute = 60 * 1000;

describe("presentBooking", () => {
  const now = new Date();

  it("shows a PENDING booking past its deadline as EXPIRED", () => {
    const b = { id: "1", status: "PENDING", expiresAt: new Date(now.getTime() - minute) };
    expect(presentBooking(b, now).status).toBe("EXPIRED");
  });

  it("keeps a PENDING booking before its deadline as PENDING", () => {
    const b = { id: "1", status: "PENDING", expiresAt: new Date(now.getTime() + minute) };
    expect(presentBooking(b, now).status).toBe("PENDING");
  });

  it("never changes a CONFIRMED booking", () => {
    const b = { id: "1", status: "CONFIRMED", expiresAt: new Date(now.getTime() - minute) };
    expect(presentBooking(b, now).status).toBe("CONFIRMED");
  });

  it("keeps the other fields", () => {
    const b = { id: "abc", status: "PENDING", expiresAt: new Date(now.getTime() + minute), totalCents: 500 };
    expect(presentBooking(b, now)).toMatchObject({ id: "abc", totalCents: 500 });
  });
});

describe("withRetry", () => {
  it("returns the result when nothing fails", async () => {
    await expect(withRetry(async () => "ok")).resolves.toBe("ok");
  });

  it("retries a deadlock and then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw { code: "40P01" };
      return "done";
    });
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  it("retries a clash on the idempotency key", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw { code: "23505", constraint: "Booking_userId_idempotencyKey_key" };
      return "replayed";
    });
    expect(result).toBe("replayed");
  });

  it("gives up after the maximum attempts", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw { code: "40001" };
      }, 3),
    ).rejects.toMatchObject({ code: "40001" });
    expect(calls).toBe(3);
  });

  it("does NOT retry normal business errors", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw { status: 409, code: "SEAT_UNAVAILABLE" };
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls).toBe(1);
  });
});
