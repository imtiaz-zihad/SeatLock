import { Router } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import * as controller from "./admin.controller.js";
import { listAuditLogsQuerySchema } from "./admin.schemas.js";

export const adminRouter = Router();

// Admins only. (To cancel any booking an admin uses POST /bookings/:id/cancel, which skips the 24h rule.)
adminRouter.use(requireAuth, requireRole("ADMIN"));

adminRouter.get("/stats", controller.stats);
adminRouter.get("/audit-logs", validate({ query: listAuditLogsQuerySchema }), controller.auditLogs);