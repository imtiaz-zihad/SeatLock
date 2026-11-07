import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];

vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown) => {
      const result = await fn({});
      order.push("transaction committed");
      return result;
    },
  },
}));

vi.mock("./booking.core.js", () => ({
  holdSeats: vi.fn(),
  cancelBooking: vi.fn(),
  expireDueBookings: vi.fn(),
}));

vi.mock("./booking.repository.js", () => ({
  findById: vi.fn(),
  listByUser: vi.fn(),
}));

import { getPaymentProvider } from "../payments/payment.providers.js";
import * as core from "./booking.core.js";
import * as repo from "./booking.repository.js";
import * as service from "./booking.service.js";

const provider = getPaymentProvider();
const cancelCore = vi.mocked(core.cancelBooking);
const alice = { id: "alice", role: "USER" };
const future = new Date(Date.now() + 60_000);

beforeEach(() => {
  order.length = 0;
  vi.resetAllMocks();
  delete process.env.CANCELLATION_CUTOFF_HOURS;
  vi.mocked(repo.findById).mockResolvedValue({ id: "b1", userId: "alice", status: "REFUNDED", expiresAt: future } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CANCELLATION_CUTOFF_HOURS;
});

describe("cancelBooking (service)", () => {
  it("refunds through the provider AFTER the transaction, then returns the booking", async () => {
    cancelCore.mockResolvedValue({ refund: { providerPaymentId: "pay_1", amountCents: 9000 } });
    const refund = vi.spyOn(provider, "refund").mockImplementation(async () => {
      order.push("refund");
    });

    const booking = await service.cancelBooking(alice, "b1");

    expect(refund).toHaveBeenCalledWith("pay_1", 9000);
    expect(order).toEqual(["transaction committed", "refund"]);
    expect(booking).toMatchObject({ id: "b1", status: "REFUNDED" });
  });

  it("does not touch the provider when nothing was paid (pending or free booking)", async () => {
    cancelCore.mockResolvedValue({ refund: null });
    const refund = vi.spyOn(provider, "refund");

    await service.cancelBooking(alice, "b1");

    expect(refund).not.toHaveBeenCalled();
  });

  it("a business error (window closed) means no refund", async () => {
    cancelCore.mockRejectedValue({ status: 409, code: "CANCELLATION_WINDOW_CLOSED" });
    const refund = vi.spyOn(provider, "refund");

    await expect(service.cancelBooking(alice, "b1")).rejects.toMatchObject({ code: "CANCELLATION_WINDOW_CLOSED" });
    expect(refund).not.toHaveBeenCalled();
  });

  it("uses a 24 hour cutoff by default", async () => {
    cancelCore.mockResolvedValue({ refund: null });
    await service.cancelBooking(alice, "b1");
    expect(cancelCore.mock.calls[0]![1]).toMatchObject({ bookingId: "b1", cutoffHours: 24, actor: alice });
  });

  it("the cutoff can be changed with CANCELLATION_CUTOFF_HOURS", async () => {
    process.env.CANCELLATION_CUTOFF_HOURS = "48";
    cancelCore.mockResolvedValue({ refund: null });
    await service.cancelBooking(alice, "b1");
    expect(cancelCore.mock.calls[0]![1]).toMatchObject({ cutoffHours: 48 });
  });

  it("a nonsense cutoff falls back to 24", async () => {
    process.env.CANCELLATION_CUTOFF_HOURS = "banana";
    cancelCore.mockResolvedValue({ refund: null });
    await service.cancelBooking(alice, "b1");
    expect(cancelCore.mock.calls[0]![1]).toMatchObject({ cutoffHours: 24 });
  });

  it("still returns the booking when the provider refund call fails (the database is already correct)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cancelCore.mockResolvedValue({ refund: { providerPaymentId: "pay_1", amountCents: 9000 } });
    vi.spyOn(provider, "refund").mockRejectedValue(new Error("provider down"));

    await expect(service.cancelBooking(alice, "b1")).resolves.toMatchObject({ id: "b1" });
  });
});