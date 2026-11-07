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

vi.mock("./cancellation.core.js", () => ({
  cancelEventWithRefunds: vi.fn(),
}));

import { getPaymentProvider } from "../payments/payment.providers.js";
import * as core from "./cancellation.core.js";
import { cancelEventAndRefund } from "./cancellation.service.js";

const provider = getPaymentProvider();
const cancelCore = vi.mocked(core.cancelEventWithRefunds);

beforeEach(() => {
  order.length = 0;
  vi.resetAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("cancelEventAndRefund", () => {
  it("asks the provider to refund every payment, and only AFTER the transaction committed", async () => {
    cancelCore.mockResolvedValue({
      bookingsRefunded: 2,
      bookingsCancelled: 1,
      refunds: [
        { providerPaymentId: "pay_a", amountCents: 5000 },
        { providerPaymentId: "pay_b", amountCents: 7000 },
      ],
    });
    const refund = vi.spyOn(provider, "refund").mockImplementation(async () => {
      order.push("refund");
    });

    const summary = await cancelEventAndRefund("event-1", "organizer-1");

    expect(summary).toEqual({ bookingsRefunded: 2, bookingsCancelled: 1, refundCallsFailed: 0 });
    expect(refund).toHaveBeenCalledWith("pay_a", 5000);
    expect(refund).toHaveBeenCalledWith("pay_b", 7000);
    expect(order[0]).toBe("transaction committed"); // never refund while the database is still locked
  });

  it("reports provider failures but still finishes (the database is already correct)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cancelCore.mockResolvedValue({
      bookingsRefunded: 2,
      bookingsCancelled: 0,
      refunds: [
        { providerPaymentId: "pay_a", amountCents: 5000 },
        { providerPaymentId: "pay_b", amountCents: 7000 },
      ],
    });
    vi.spyOn(provider, "refund").mockImplementation(async (id) => {
      if (id === "pay_b") throw new Error("provider down");
    });

    const summary = await cancelEventAndRefund("event-1", "organizer-1");

    expect(summary.refundCallsFailed).toBe(1);
    expect(summary.bookingsRefunded).toBe(2);
  });

  it("does not call the provider when there is nothing to refund", async () => {
    cancelCore.mockResolvedValue({ bookingsRefunded: 0, bookingsCancelled: 3, refunds: [] });
    const refund = vi.spyOn(provider, "refund");

    const summary = await cancelEventAndRefund("event-1", "organizer-1");

    expect(refund).not.toHaveBeenCalled();
    expect(summary).toEqual({ bookingsRefunded: 0, bookingsCancelled: 3, refundCallsFailed: 0 });
  });

  it("passes the event and the actor to the core", async () => {
    cancelCore.mockResolvedValue({ bookingsRefunded: 0, bookingsCancelled: 0, refunds: [] });

    await cancelEventAndRefund("event-9", "organizer-7");

    expect(cancelCore.mock.calls[0]![1]).toMatchObject({ eventId: "event-9", actorId: "organizer-7" });
  });

  it("a business error (event already cancelled) stops everything: no refunds", async () => {
    cancelCore.mockRejectedValue({ status: 409, code: "INVALID_STATE" });
    const refund = vi.spyOn(provider, "refund");

    await expect(cancelEventAndRefund("event-1", "organizer-1")).rejects.toMatchObject({ status: 409 });
    expect(refund).not.toHaveBeenCalled();
  });
});