import { Router } from "express";
import { optionalAuth, organizerOnly } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { eventIdParamSchema } from "../events/event.schemas.js";
import * as controller from "./tire.controller.js";
import { createTierSchema, tierParamSchema, updateTierSchema } from "./tire.schemas.js"

// Mounted at /events/:id/tiers, so it needs mergeParams to see :id.
export const tierRouter = Router({ mergeParams: true });

tierRouter.get("/", optionalAuth, validate({ params: eventIdParamSchema }), controller.list);
tierRouter.post("/", ...organizerOnly, validate({ params: eventIdParamSchema, body: createTierSchema }), controller.create);
tierRouter.patch(
  "/:tierId",
  ...organizerOnly,
  validate({ params: tierParamSchema, body: updateTierSchema }),
  controller.update,
);
tierRouter.delete("/:tierId", ...organizerOnly, validate({ params: tierParamSchema }), controller.remove);
