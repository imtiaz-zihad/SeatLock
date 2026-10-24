import express from "express";
import cors from "cors";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import { requireAuth, requireRole } from "./middlewares/auth.js";

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  }),
);

// IMPORTANT: Better Auth handler express.json()-er AGE.
// Express 5 (ei guide) = "*splat". Express 4 hole "/api/auth/*".
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