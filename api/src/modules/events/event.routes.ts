import { Router } from "express";
import { optionalAuth, organizerOnly } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import * as controller from "./event.controller.js";
import {
  createEventSchema,
  eventIdParamSchema,
  listEventsQuerySchema,
  updateEventSchema,
} from "./event.schemas.js";

export const eventRouter = Router();

// Public
eventRouter.get("/", validate({ query: listEventsQuerySchema }), controller.list);
eventRouter.get("/:id", optionalAuth, validate({ params: eventIdParamSchema }), controller.getById);

// Organizer / Admin (ownership is checked in the service)
eventRouter.post("/", ...organizerOnly, validate({ body: createEventSchema }), controller.create);
eventRouter.patch(
  "/:id",
  ...organizerOnly,
  validate({ params: eventIdParamSchema, body: updateEventSchema }),
  controller.update,
);
eventRouter.post("/:id/publish", ...organizerOnly, validate({ params: eventIdParamSchema }), controller.publish);
eventRouter.post("/:id/cancel", ...organizerOnly, validate({ params: eventIdParamSchema }), controller.cancel);
eventRouter.delete("/:id", ...organizerOnly, validate({ params: eventIdParamSchema }), controller.remove);
