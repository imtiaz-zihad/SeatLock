import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import type { PaymentEvent, PaymentProvider } from "./payment.provider.js";

// A pretend payment company for development, demos and tests.
// It behaves like a real one: it signs its webhooks, and we verify them.
//
// Signature header:  x-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
// (the same idea Stripe uses: a timestamp stops old requests from being replayed)

const bodySchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(["payment.succeeded", "payment.failed"]),
  data: z.object({
    providerPaymentId: z.string().min(1).max(200),
    amountCents: z.number().int().min(0),
    currency: z.string().length(3),
  }),
});

const invalidSignature = (message: string) => new AppError(400, "INVALID_SIGNATURE", message);

export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake";

  constructor(
    private readonly secret: string,
    private readonly toleranceSeconds = 300,
  ) {}

  async createPayment(input: { bookingId: string; amountCents: number; currency: string }) {
    const providerPaymentId = `fake_pay_${randomUUID()}`;
    return {
      providerPaymentId,
      checkout: {
        type: "fake",
        note: "Development only: call one of these URLs to finish the payment",
        succeedUrl: `/dev/payments/${providerPaymentId}/succeed`,
        failUrl: `/dev/payments/${providerPaymentId}/fail`,
        amountCents: input.amountCents,
        currency: input.currency,
      },
    };
  }

  sign(rawBody: string | Buffer, now = new Date()): string {
    const t = Math.floor(now.getTime() / 1000);
    return `t=${t},v1=${this.hmac(t, rawBody)}`;
  }

  // Builds a webhook body + signature, like the real provider would send it.
  buildWebhook(
    type: PaymentEvent["type"],
    data: { providerPaymentId: string; amountCents: number; currency: string },
    eventId = `evt_${randomUUID()}`,
    now = new Date(),
  ) {
    const body = JSON.stringify({ id: eventId, type, data });
    return { body, signature: this.sign(body, now) };
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, now: Date): PaymentEvent {
    if (!signatureHeader) throw invalidSignature("Missing x-signature header");

    const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signatureHeader.trim());
    if (!match) throw invalidSignature("Malformed x-signature header");

    const t = Number(match[1]);
    const expected = Buffer.from(this.hmac(t, rawBody), "hex");
    const received = Buffer.from(match[2]!, "hex");

    // timingSafeEqual compares in constant time, so an attacker cannot guess the signature byte by byte.
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw invalidSignature("Signature does not match");
    }
    if (Math.abs(now.getTime() / 1000 - t) > this.toleranceSeconds) {
      throw invalidSignature("Signature timestamp is too old");
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new AppError(400, "INVALID_PAYLOAD", "Webhook body is not valid JSON");
    }

    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      throw new AppError(400, "INVALID_PAYLOAD", "Webhook body has the wrong shape");
    }

    const { id, type, data } = parsed.data;
    return {
      id,
      type,
      providerPaymentId: data.providerPaymentId,
      amountCents: data.amountCents,
      currency: data.currency,
      raw: json,
    };
  }

  async refund(_providerPaymentId: string, _amountCents: number): Promise<void> {
    // Nothing to call: the fake provider has no real money.
  }

  private hmac(t: number, rawBody: string | Buffer) {
    return createHmac("sha256", this.secret).update(`${t}.`).update(rawBody).digest("hex");
  }
}