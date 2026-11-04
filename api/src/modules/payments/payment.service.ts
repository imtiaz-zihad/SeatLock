import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { type PrismaTx, prismaSql } from "../../lib/sql.js";
import type { Actor } from "../../lib/types.js";
import { withRetry } from "../bookings/booking.utils.js";
import * as core from "./payment.core.js";
import { getPaymentProvider, isFakeProvider } from "./payment.providers.js";

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 };

// POST /bookings/:id/pay
export async function startPayment(actor: Actor, bookingId: string) {
  const provider = getPaymentProvider();

  return withRetry<core.InitiateResult>(() =>
    prisma.$transaction(
      (tx: PrismaTx) =>
        core.initiatePayment(prismaSql(tx), {
          bookingId,
          userId: actor.id,
          now: new Date(),
          providerName: provider.name,
          createWithProvider: (p) => provider.createPayment(p),
        }),
      TX_OPTIONS,
    ),
  );
}

// POST /webhooks/payments. The raw body is needed to check the signature.
export async function handleWebhook(rawBody: Buffer, signatureHeader: string | undefined) {
  const provider = getPaymentProvider();

  // Throws 400 when the signature or body is wrong. Nothing is stored for a bad request.
  const event = provider.verifyWebhook(rawBody, signatureHeader, new Date());

  const outcome = await withRetry<core.WebhookOutcome>(() =>
    prisma.$transaction(
      (tx: PrismaTx) => core.processWebhookEvent(prismaSql(tx), { event, provider: provider.name, now: new Date() }),
      TX_OPTIONS,
    ),
  );

  // The customer paid but cannot get the ticket: give the money back.
  // This is done AFTER the database transaction, never while holding database locks.
  // The payment is already marked REFUNDED in our database. If the provider call fails we log it
  // loudly. A production system would also queue the refund and retry it (the "outbox" pattern).
  if (outcome.result === "processed" && outcome.refund) {
    try {
      await provider.refund(outcome.refund.providerPaymentId, outcome.refund.amountCents);
    } catch (err) {
      console.error("[payments] AUTO-REFUND FAILED: refund this payment by hand", outcome.refund, err);
    }
  }

  return outcome;
}

// Development only: pretend the payment company sent a webhook for this payment.
// It goes through the SAME signature check and handler as a real webhook.
export async function simulateFakeWebhook(
  providerPaymentId: string,
  outcome: "succeeded" | "failed",
  eventId?: string,
) {
  const provider = getPaymentProvider();
  if (!isFakeProvider(provider)) throw AppError.notFound("Route");

  const payment = await prisma.payment.findUnique({ where: { providerPaymentId } });
  if (!payment) throw AppError.notFound("Payment");

  const { body, signature } = provider.buildWebhook(
    outcome === "succeeded" ? "payment.succeeded" : "payment.failed",
    { providerPaymentId, amountCents: payment.amountCents, currency: payment.currency },
    eventId,
  );

  return handleWebhook(Buffer.from(body), signature);
}