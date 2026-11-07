import { getPaymentProvider } from "./payment.providers.js";

export type RefundRequest = { providerPaymentId: string; amountCents: number };

// Gives the money back through the payment provider.
// Call this AFTER the database transaction has committed, never while holding database locks.
// The payments are already marked REFUNDED in our database. If a provider call fails we log it loudly
// and count it. A production system would also queue such refunds and retry them (the "outbox" pattern).
export async function issueRefunds(refunds: RefundRequest[], concurrency = 5): Promise<{ failed: number }> {
  if (refunds.length === 0) return { failed: 0 };

  const provider = getPaymentProvider();
  let failed = 0;
  let next = 0;

  // a few refunds at a time, so one event with thousands of bookings does not flood the provider
  const worker = async () => {
    while (next < refunds.length) {
      const refund = refunds[next++]!;
      try {
        await provider.refund(refund.providerPaymentId, refund.amountCents);
      } catch (err) {
        failed++;
        console.error("[payments] REFUND FAILED: refund this payment by hand", refund, err);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, refunds.length) }, worker));
  return { failed };
}