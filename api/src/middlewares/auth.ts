import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { AppError } from "../lib/errors.js";
import type { Actor } from "../lib/types.js";

// Loads the session (if any) and stores user/session in res.locals.
async function loadSession(req: Request, res: Response) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (session) {
    res.locals.user = session.user;
    res.locals.session = session.session;
  }
  return session;
}

// Login is required.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = await loadSession(req, res);
  if (!session) {
    return next(AppError.unauthorized());
  }
  next();
}

// Login is optional (public route that behaves differently for owners).
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  await loadSession(req, res);
  next();
}

// Role check: requireRole("ORGANIZER", "ADMIN"). Use after requireAuth.
export function requireRole(...roles: string[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user as { role?: string | null } | undefined;

    if (!user || !roles.includes(user.role ?? "")) {
      return next(AppError.forbidden());
    }
    next();
  };
}

// Shortcut for routes only organizers and admins may use.
export const organizerOnly = [requireAuth, requireRole("ORGANIZER", "ADMIN")];

// The current user as an Actor, or null when not signed in.
export function getActor(res: Response): Actor | null {
  const user = res.locals.user as { id: string; role?: string | null } | undefined;
  if (!user) return null;
  return { id: user.id, role: user.role ?? "USER" };
}
