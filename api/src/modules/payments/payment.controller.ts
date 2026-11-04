import type { Request, Response } from "express";
import { AppError } from "../../lib/errors.js";
import { getActor } from "../../middlewares/auth.js";
import * as service from "./payment.service.js";

type Validated<T> = { validated: T };

// POST /bookings/:id/pay
export async function pay(_req: Request, res: Response) {
  const { params } = (res.locals as Validated<{ params: { id: string } }>).validated;
  const result = await service.startPayment(getActor(res)!, params.id);

  if (result.kind === "free") {
    // nothing to pay: the booking is already confirmed
    return res.status(200).json({ data: { free: true, bookingId: result.bookingId, bookingStatus: "CONFIRMED" } });
  }

  const { kind: _kind, ...payment } = result;
  res.status(payment.replayed ? 200 : 201).json({ data: payment });
}

// POST /webhooks/payments  (called by the payment company, not by a user)
export async function receiveWebhook(req: Request, res: Response) {
  if (!Buffer.isBuffer(req.body)) {
    throw new AppError(400, "INVALID_PAYLOAD", "Send the webhook as application/json");
  }

  const outcome = await service.handleWebhook(req.body, req.get("x-signature"));

  // Always answer 200 once we accepted the event, even for duplicates, so the provider stops retrying.
  res.status(200).json({ received: true, result: outcome.result });
}

// POST /dev/payments/:providerPaymentId/succeed  and  /fail  (development only)
export function simulate(outcome: "succeeded" | "failed") {
  return async (_req: Request, res: Response) => {
    const { params, body } = (
      res.locals as Validated<{ params: { providerPaymentId: string }; body?: { eventId?: string } }>
    ).validated;

    const result = await service.simulateFakeWebhook(params.providerPaymentId, outcome, body?.eventId);
    res.json({ data: result });
  };
}