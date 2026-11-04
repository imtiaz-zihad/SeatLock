import { FakePaymentProvider } from "./fake.provider.js";
import type { PaymentProvider } from "./payment.provider.js";

let cached: PaymentProvider | null = null;

// Chooses the payment provider from PAYMENT_PROVIDER (default "fake").
export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;

  const name = process.env.PAYMENT_PROVIDER ?? "fake";

  if (name === "fake") {
    // Safety: the pretend provider must never run in production by accident.
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_FAKE_PAYMENTS !== "true") {
      throw new Error("The fake payment provider is disabled in production. Set ALLOW_FAKE_PAYMENTS=true for a demo.");
    }
    cached = new FakePaymentProvider(process.env.FAKE_PAYMENT_WEBHOOK_SECRET ?? "dev-fake-webhook-secret");
    return cached;
  }

  throw new Error(`Unknown PAYMENT_PROVIDER "${name}"`);
}

export function isFakeProvider(provider: PaymentProvider): provider is FakePaymentProvider {
  return provider instanceof FakePaymentProvider;
}