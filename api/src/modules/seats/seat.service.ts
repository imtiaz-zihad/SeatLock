import { AppError } from "../../lib/errors.js";
import { isUniqueViolation } from "../../lib/prisma-error.js";
import type { Actor } from "../../lib/types.js";
import { assertEventOpen } from "../events/event.rules.js";
import * as eventService from "../events/event.service.js";
import * as tierRepo from "../tiers/tire.repository.js";
import * as repo from "./seat.repository.js";
import type { BulkSeatsInput, ListSeatsQuery } from "./seat.schemas.js";

type SeatStatus = "AVAILABLE" | "HELD" | "SOLD";

type SeatRow = {
  id: string;
  section: string;
  row: string;
  number: number;
  tierId: string;
  status: string;
  holdExpiresAt: Date | null;
};

// A hold whose time ran out is free again, even if the cleanup job has not run yet.
// The booking module must use this same rule.
export function effectiveSeatStatus(
  seat: { status: string; holdExpiresAt: Date | null },
  now = new Date(),
): SeatStatus {
  if (seat.status === "HELD" && seat.holdExpiresAt && seat.holdExpiresAt <= now) {
    return "AVAILABLE";
  }
  return seat.status as SeatStatus;
}

export async function generateSeats(eventId: string, actor: Actor, input: BulkSeatsInput) {
  const event = await eventService.getManageableEvent(eventId, actor);
  assertEventOpen(event);

  const tier = await tierRepo.findInEvent(input.tierId, eventId);
  if (!tier) {
    throw AppError.validation([{ path: "body.tierId", message: "This tier does not belong to the event" }]);
  }

  const seats = input.rows.flatMap((row) =>
    Array.from({ length: input.seatsPerRow }, (_, i) => ({
      eventId,
      tierId: tier.id,
      section: input.section,
      row,
      number: input.startNumber + i,
    })),
  );

  try {
    const result = await repo.createMany(seats);
    return { created: result.count };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict("SEAT_CONFLICT", "Some of these seats already exist in this section");
    }
    throw err;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true }); // "2" before "10"

// Seat map: sections -> rows -> seats, plus counts.
export async function getSeatMap(eventId: string, actor: Actor | null, query: ListSeatsQuery) {
  await eventService.getEvent(eventId, actor); // same visibility as the event

  const now = new Date();
  const rows: SeatRow[] = await repo.listByEvent(eventId, query);

  const seats = rows
    .map((s) => ({
      id: s.id,
      section: s.section,
      row: s.row,
      number: s.number,
      tierId: s.tierId,
      status: effectiveSeatStatus(s, now),
    }))
    .filter((s) => !query.status || s.status === query.status);

  const summary = { total: seats.length, available: 0, held: 0, sold: 0 };
  const bySection = new Map<string, Map<string, typeof seats>>();

  for (const seat of seats) {
    if (seat.status === "AVAILABLE") summary.available++;
    else if (seat.status === "HELD") summary.held++;
    else summary.sold++;

    const sectionRows = bySection.get(seat.section) ?? new Map<string, typeof seats>();
    const rowSeats = sectionRows.get(seat.row) ?? [];
    rowSeats.push(seat);
    sectionRows.set(seat.row, rowSeats);
    bySection.set(seat.section, sectionRows);
  }

  const sections = [...bySection.entries()]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([section, sectionRows]) => ({
      section,
      rows: [...sectionRows.entries()]
        .sort(([a], [b]) => collator.compare(a, b))
        .map(([row, rowSeats]) => ({
          row,
          seats: rowSeats
            .sort((a, b) => a.number - b.number)
            .map((s) => ({ id: s.id, number: s.number, tierId: s.tierId, status: s.status })),
        })),
    }));

  return { eventId, summary, sections };
}
