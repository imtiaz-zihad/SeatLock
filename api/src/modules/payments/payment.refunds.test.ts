import { afterEach, describe, expect, it, vi } from "vitest";
import { getPaymentProvider } from "./payment.providers.js";
import { issueRefunds } from "./payment.refunds.js";

const provider = getPaymentProvider();
const refundsFor = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ providerPaymentId: `pay_${i}`, amountCents: 1000 + i }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("issueRefunds", () => {
  it("does nothing for an empty list", async () => {
    const spy = vi.spyOn(provider, "refund");
    await expect(issueRefunds([])).resolves.toEqual({ failed: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends every refund to the provider with the right amount", async () => {
    const spy = vi.spyOn(provider, "refund").mockResolvedValue();

    const result = await issueRefunds(refundsFor(12));

    expect(result).toEqual({ failed: 0 });
    expect(spy).toHaveBeenCalledTimes(12);
    expect(spy).toHaveBeenCalledWith("pay_3", 1003);
  });

  it("counts failures and still tries all the others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(provider, "refund").mockImplementation(async (id) => {
      if (id === "pay_2" || id === "pay_7") throw new Error("provider down");
    });

    const result = await issueRefunds(refundsFor(10));

    expect(result).toEqual({ failed: 2 });
    expect(spy).toHaveBeenCalledTimes(10);
  });

  it("never sends more than 5 refunds at the same moment", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(provider, "refund").mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });

    await issueRefunds(refundsFor(40));

    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1); // and it really does work in parallel
  });
});