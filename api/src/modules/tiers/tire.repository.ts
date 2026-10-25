import { prisma } from "../../lib/prisma.js";
import type { CreateTierInput, UpdateTierInput } from "./tire.schemas.js";

export function create(eventId: string, input: CreateTierInput) {
  return prisma.ticketTier.create({ data: { ...input, eventId } });
}

export function listByEvent(eventId: string) {
  return prisma.ticketTier.findMany({
    where: { eventId },
    orderBy: [{ priceCents: "desc" }, { name: "asc" }],
  });
}

// A tier only counts if it belongs to the given event.
export function findInEvent(tierId: string, eventId: string) {
  return prisma.ticketTier.findFirst({ where: { id: tierId, eventId } });
}

export function update(tierId: string, data: UpdateTierInput) {
  return prisma.ticketTier.update({ where: { id: tierId }, data });
}

export function remove(tierId: string) {
  return prisma.ticketTier.delete({ where: { id: tierId } });
}

export function countSeats(tierId: string) {
  return prisma.seat.count({ where: { tierId } });
}

// Seats that are held or sold must never change price.
export function countLockedSeats(tierId: string) {
  return prisma.seat.count({ where: { tierId, status: { in: ["HELD", "SOLD"] } } });
}
