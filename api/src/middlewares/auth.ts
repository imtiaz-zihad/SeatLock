import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

// Login kora ache kina check kore
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.locals.user = session.user;
  res.locals.session = session.session;
  next();
}

// Role check: requireRole("ORGANIZER", "ADMIN")
export function requireRole(...roles: string[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user as { role?: string } | undefined;

    if (!user || !roles.includes(user.role ?? "")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}