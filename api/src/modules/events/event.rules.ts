import { AppError } from "../../lib/errors.js";

// A cancelled or completed event is frozen: no edits, no new tiers or seats.
export function assertEventOpen(event: { status: string }) {
  if (event.status === "CANCELLED" || event.status === "COMPLETED") {
    throw AppError.conflict("EVENT_NOT_EDITABLE", `A ${event.status.toLowerCase()} event cannot be edited`);
  }
}
