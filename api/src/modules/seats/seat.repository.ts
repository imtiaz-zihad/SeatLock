import { prisma } from "../../lib/prisma.js";
import type { ListSeatsQuery } from "./seat.schemas.js";

type NewSeat = {
  eventId: string;
  tierId: string;
  section: string;
  row: string;
  number: number;
};

// One INSERT for all seats: either every seat is created or none (unique clash).
export function createMany(seats: NewSeat[]) {
  return prisma.seat.createMany({ data: seats });
}

// Status is filtered in the service, because an expired hold counts as available there.
export function listByEvent(eventId: string, filters: Pick<ListSeatsQuery, "section" | "tierId">) {
  return prisma.seat.findMany({
    where: {
      eventId,
      ...(filters.section ? { section: filters.section } : {}),
      ...(filters.tierId ? { tierId: filters.tierId } : {}),
    },
    select: {
      id: true,
      section: true,
      row: true,
      number: true,
      tierId: true,
      status: true,
      holdExpiresAt: true,
    },
  });
}
