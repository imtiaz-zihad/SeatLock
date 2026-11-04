import { z } from "zod";

export const bookingIdParamSchema = z.object({
  id: z.uuid(),
});

export const providerPaymentIdParamSchema = z.object({
  providerPaymentId: z.string().min(1).max(200),
});

// Optional body for the development-only "finish the payment" URLs.
// Sending the same eventId twice lets you test duplicate webhooks by hand.
export const simulateBodySchema = z
  .object({
    eventId: z.string().trim().min(1).max(100).optional(),
  })
  .optional();