import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import * as controller from "./booking.controller.js";
import {
  bookingIdParamSchema,
  createBookingSchema,
  idempotencyHeaderSchema,
  listBookingsQuerySchema,
} from "./booking.schemas.js";

export const bookingRouter = Router();

// Every booking route needs a signed-in user.
bookingRouter.use(requireAuth);

bookingRouter.post("/", validate({ headers: idempotencyHeaderSchema, body: createBookingSchema }), controller.create);
bookingRouter.get("/", validate({ query: listBookingsQuerySchema }), controller.list);
bookingRouter.get("/:id", validate({ params: bookingIdParamSchema }), controller.getById);
bookingRouter.post("/:id/cancel", validate({ params: bookingIdParamSchema }), controller.cancel);
