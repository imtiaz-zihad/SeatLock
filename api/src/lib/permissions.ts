import { AppError } from "./errors.js";
import type { Actor } from "./types.js";

// Admins can manage every event, organizers only their own.
export function canManageEvent(event: { organizerId: string }, actor: Actor | null) {
  if (!actor) return false;
  return actor.role === "ADMIN" || event.organizerId === actor.id;
}

export function assertCanManageEvent(event: { organizerId: string }, actor: Actor) {
  if (!canManageEvent(event, actor)) {
    throw AppError.forbidden("You can only manage your own events");
  }
}
