import { prisma } from "../../lib/prisma.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { CreateEventInput, ListEventsQuery, UpdateEventInput } from "./event.schemas.js";

// Only database access lives here. No business rules.

const withOrganizer = {
  organizer: { select: { id: true, name: true } },
} as const;

export function create(organizerId: string, input: CreateEventInput) {
  return prisma.event.create({
    data: { ...input, organizerId, status: "DRAFT" },
    include: withOrganizer,
  });
}

// Returns soft-deleted events as "not found".
export function findById(id: string) {
  return prisma.event.findFirst({
    where: { id, deletedAt: null },
    include: withOrganizer,
  });
}

export function listPublished(query: ListEventsQuery) {
  const { q, from, to, limit, cursor } = query;

  const where: Prisma.EventWhereInput = {
    status: "PUBLISHED",
    deletedAt: null,
    ...(from || to
      ? { startsAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }
      : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { venue: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  return prisma.event.findMany({
    where,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: limit + 1, // one extra row tells us if there is a next page
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: withOrganizer,
  });
}

export function update(id: string, data: UpdateEventInput | { status: "PUBLISHED" | "CANCELLED" }) {
  return prisma.event.update({
    where: { id },
    data,
    include: withOrganizer,
  });
}

export function softDelete(id: string) {
  return prisma.event.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

// How much of the event is set up. Used by the publish rule.
export async function countSetup(eventId: string) {
  const [tiers, seats] = await Promise.all([
    prisma.ticketTier.count({ where: { eventId } }),
    prisma.seat.count({ where: { eventId } }),
  ]);
  return { tiers, seats };
}
