import type { Sql } from "../../lib/sql.js";

// Read-only reports for admins. Plain SQL, no business rules.

const ts = (n: number) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;

const BOOKING_STATUSES = ["PENDING", "CONFIRMED", "EXPIRED", "CANCELLED", "REFUNDED"] as const;
const EVENT_STATUSES = ["DRAFT", "PUBLISHED", "CANCELLED", "COMPLETED"] as const;

export type AdminStats = {
  events: Record<string, number>;
  bookings: Record<string, number>;
  seats: { total: number; available: number; held: number; sold: number };
  money: Array<{ currency: string; paidCents: number; refundedCents: number; netCents: number }>;
  rates: {
    holdExpiryRate: number; // expired bookings / all bookings
    refundRate: number; // refunded / (confirmed + refunded)
  };
};

const zeroFilled = (keys: readonly string[], rows: Array<{ status: string; count: number }>) => {
  const result: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const row of rows) result[row.status] = row.count;
  return result;
};

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export async function getStats(sql: Sql, nowIso: string): Promise<AdminStats> {
  const events = await sql.query<{ status: string; count: number }>(
    `SELECT status::text AS status, count(*)::int AS count FROM "Event" WHERE "deletedAt" IS NULL GROUP BY status`,
  );
  const bookings = await sql.query<{ status: string; count: number }>(
    `SELECT status::text AS status, count(*)::int AS count FROM "Booking" GROUP BY status`,
  );

  // An expired hold counts as available, exactly like the seat map shows it.
  const seats = await sql.query<{ status: string; count: number }>(
    `SELECT (CASE WHEN status = 'HELD' AND "holdExpiresAt" <= ${ts(1)} THEN 'AVAILABLE' ELSE status::text END) AS status,
            count(*)::int AS count
       FROM "Seat" GROUP BY 1`,
    [nowIso],
  );

  // sum() can be bigger than a normal integer, so it is read as text.
  const money = await sql.query<{ currency: string; paid: string; refunded: string }>(
    `SELECT currency,
            COALESCE(sum("amountCents") FILTER (WHERE status = 'SUCCEEDED'), 0)::text AS paid,
            COALESCE(sum("amountCents") FILTER (WHERE status = 'REFUNDED'), 0)::text AS refunded
       FROM "Payment" GROUP BY currency ORDER BY currency`,
  );

  const bookingCounts = zeroFilled(BOOKING_STATUSES, bookings);
  const seatCounts = zeroFilled(["AVAILABLE", "HELD", "SOLD"], seats);
  const totalBookings = Object.values(bookingCounts).reduce((a, b) => a + b, 0);
  const everPaid = bookingCounts.CONFIRMED! + bookingCounts.REFUNDED!;

  return {
    events: zeroFilled(EVENT_STATUSES, events),
    bookings: bookingCounts,
    seats: {
      total: seatCounts.AVAILABLE! + seatCounts.HELD! + seatCounts.SOLD!,
      available: seatCounts.AVAILABLE!,
      held: seatCounts.HELD!,
      sold: seatCounts.SOLD!,
    },
    money: money.map((m) => {
      const paidCents = Number(m.paid);
      const refundedCents = Number(m.refunded);
      return { currency: m.currency, paidCents, refundedCents, netCents: paidCents };
    }),
    rates: {
      holdExpiryRate: totalBookings === 0 ? 0 : round4(bookingCounts.EXPIRED! / totalBookings),
      refundRate: everPaid === 0 ? 0 : round4(bookingCounts.REFUNDED! / everPaid),
    },
  };
}

export type AuditFilters = {
  limit: number;
  cursor?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  actorId?: string;
};

export type AuditRow = {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
};

// Newest first. The cursor is the id of the last row of the previous page.
export async function listAuditLogs(sql: Sql, filters: AuditFilters): Promise<AuditRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (condition: (n: number) => string, value: unknown) => {
    params.push(value);
    where.push(condition(params.length));
  };

  if (filters.entityType) add((n) => `"entityType" = $${n}`, filters.entityType);
  if (filters.entityId) add((n) => `"entityId" = $${n}`, filters.entityId);
  if (filters.action) add((n) => `action = $${n}`, filters.action);
  if (filters.actorId) add((n) => `"actorId" = $${n}`, filters.actorId);
  if (filters.cursor) {
    add((n) => `("createdAt", id) < (SELECT "createdAt", id FROM "AuditLog" WHERE id = $${n})`, filters.cursor);
  }

  params.push(filters.limit + 1); // one extra row tells us if there is a next page

  return sql.query<AuditRow>(
    `SELECT id, "actorId", action, "entityType", "entityId", metadata, "createdAt"
       FROM "AuditLog"
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY "createdAt" DESC, id DESC
      LIMIT $${params.length}::int`,
    params,
  );
}