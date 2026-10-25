import express from "express";
import cors from "cors";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import { requireAuth, requireRole } from "./middlewares/auth.js";
import { errorHandler, notFoundHandler } from "./middlewares/error-handler.js";
import { eventRouter } from "./modules/events/event.routes.js";
import { seatRouter } from "./modules/seats/seat.routes.js";
import { tierRouter } from "./modules/tiers/tire.routes.js"

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  }),
);

// IMPORTANT: Better Auth handler must come BEFORE express.json().
// Express 5 = "*splat". Express 4 would be "/api/auth/*".
app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/api/me", requireAuth, (_req, res) => {
  res.json({ user: res.locals.user });
});

app.get("/api/organizer/ping", requireAuth, requireRole("ORGANIZER", "ADMIN"), (_req, res) => {
  res.json({ message: "organizer access ok" });
});

app.use("/events", eventRouter);
app.use("/events/:id/tiers", tierRouter);
app.use("/events/:id/seats", seatRouter);

// These two must stay at the very end.
app.use(notFoundHandler);
app.use(errorHandler);