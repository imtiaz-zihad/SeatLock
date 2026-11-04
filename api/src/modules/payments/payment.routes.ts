import express, { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import * as controller from "./payment.controller.js";
import { bookingIdParamSchema, providerPaymentIdParamSchema, simulateBodySchema } from "./payment.schemas.js";

// Mounted at /bookings/:id/pay
export const payRouter = Router({ mergeParams: true });
payRouter.post("/", requireAuth, validate({ params: bookingIdParamSchema }), controller.pay);

// Mounted at /webhooks BEFORE express.json().
// The signature is calculated over the exact bytes we received, so we keep the body raw.
export const webhookRouter = Router();
webhookRouter.post("/payments", express.raw({ type: "application/json", limit: "100kb" }), controller.receiveWebhook);

// Mounted at /dev, only outside production. Lets you finish a fake payment by hand.
export const devPaymentRouter = Router();
const devValidate = validate({ params: providerPaymentIdParamSchema, body: simulateBodySchema });
devPaymentRouter.post("/payments/:providerPaymentId/succeed", express.json(), devValidate, controller.simulate("succeeded"));
devPaymentRouter.post("/payments/:providerPaymentId/fail", express.json(), devValidate, controller.simulate("failed"));