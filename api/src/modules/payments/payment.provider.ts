// What the rest of the app needs from ANY payment company.
// Today: FakePaymentProvider. Later: Stripe, SSLCommerz... only a new class, no other change.

export type PaymentEvent = {
  id: string; // unique per event: the same event delivered twice has the same id
  type: "payment.succeeded" | "payment.failed";
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  raw: unknown; // stored as-is in WebhookEvent.payload
};

export interface PaymentProvider {
  readonly name: string;

  // Ask the provider to start a payment. Returns what the client needs to pay.
  createPayment(input: {
    bookingId: string;
    amountCents: number;
    currency: string;
  }): Promise<{ providerPaymentId: string; checkout: unknown }>;

  // Check the signature and turn the raw request body into an event.
  // Must throw AppError(400) when the signature or body is wrong.
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, now: Date): PaymentEvent;

  // Give the money back.
  refund(providerPaymentId: string, amountCents: number): Promise<void>;
}