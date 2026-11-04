import { prisma } from "../../lib/prisma.js";
import type { ListBookingsQuery } from "./booking.schemas.js";

// Reads only. Writes that decide seat ownership live in booking.core.ts (raw SQL).

const bookingInclude = {
  event: { select: { id: true, title: true, venue: true, startsAt: true } },
  payments: {
    select: { id: true, status: true, amountCents: true, currency: true, provider: true, providerPaymentId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  },
  items: {
    where: { isActive: true },
    select: {
      id: true,
      priceCents: true,
      seat: { select: { id: true, section: true, row: true, number: true } },
    },
  },
} as const;

export function findById(id: string) {
  return prisma.booking.findUnique({ where: { id }, include: bookingInclude });
}

export function listByUser(userId: string, query: ListBookingsQuery) {
  const { limit, cursor } = query;

  return prisma.booking.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: bookingInclude,
  });
}