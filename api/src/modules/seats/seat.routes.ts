import { Router } from "express";
import { optionalAuth, organizerOnly } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { eventIdParamSchema } from "../events/event.schemas.js";
import * as controller from "./seat.controller.js";
import { bulkSeatsSchema, listSeatsQuerySchema } from "./seat.schemas.js";

// Mounted at /events/:id/seats
export const seatRouter = Router({ mergeParams: true });

seatRouter.get(
  "/",
  optionalAuth,
  validate({ params: eventIdParamSchema, query: listSeatsQuerySchema }),
  controller.seatMap,
);
seatRouter.post(
  "/bulk",
  ...organizerOnly,
  validate({ params: eventIdParamSchema, body: bulkSeatsSchema }),
  controller.generate,
);
