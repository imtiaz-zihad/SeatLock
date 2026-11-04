import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "../../lib/sql.js";
import { createTestDb } from "../../tests/pg-helpers.js";
import { cancelBooking, expireDueBookings, holdSeats } from "./booking.core.js";

// Runs the real booking SQL against a real PostgreSQL database.
// Skipped unless TEST_DATABASE_URL is set. Use a SEPARATE test database:
// every run empties its tables.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("booking core on a real database", () => {
  const db = createTestDb(url);
  const { q, inTx, race, createUsers, createEvent, seatStatus } = db;

  const holdJob = (userId: string, eventId: string, seatIds: string[], key: string = randomUUID()) => (sql: Sql) =>
    holdSeats(sql, { userId, eventId, seatIds, idempotencyKey: key, holdMinutes: 15, now: new Date() });

  const hold = (userId: string, eventId: string, seatIds: string[], key: string = randomUUID()) =>
    inTx((sql) => holdSeats(sql, { userId, eventId, seatIds, idempotencyKey: key, holdMinutes: 15, now: new Date() }));


  // ---------- lifecycle ----------
  beforeAll(async () => {
    await q("SELECT 1");
  });
  beforeEach(async () => {
    await db.reset();
  });
  afterAll(async () => {
    await db.close();
  });

  // ---------- tests ----------
  it("holds seats and creates a PENDING booking with the right total", async () => {
    const { eventId, seatIds } = await createEvent(3, { priceCents: 5000 });
    const [user] = await createUsers(1);

    const result = await hold(user!, eventId, [seatIds[0]!, seatIds[1]!]);

    expect(result.replayed).toBe(false);
    const [booking] = await q<{ status: string; totalCents: number; expiresAt: Date }>(
      `SELECT status::text AS status, "totalCents", "expiresAt" FROM "Booking" WHERE id = $1`,
      [result.bookingId],
    );
    expect(booking!.status).toBe("PENDING");
    expect(booking!.totalCents).toBe(10000);
    expect(await seatStatus(seatIds[0]!)).toBe("HELD");
    expect(await seatStatus(seatIds[1]!)).toBe("HELD");
    expect(await seatStatus(seatIds[2]!)).toBe("AVAILABLE");
    const audit = await q(`SELECT 1 FROM "AuditLog" WHERE action = 'BOOKING_CREATED' AND "entityId" = $1`, [result.bookingId]);
    expect(audit).toHaveLength(1);
  });

  it("50 people race for ONE seat: exactly one wins", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const users = await createUsers(50);

    const results = await race(users.map((u) => holdJob(u, eventId, [seatIds[0]!])));

    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(49);
    // every loser failed for the right reason (no deadlock, no random DB error)
    for (const l of losers) {
      expect(l.reason).toMatchObject({ status: 409, code: "SEAT_UNAVAILABLE" });
    }

    expect(await q(`SELECT 1 FROM "Booking"`)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM "BookingItem" WHERE "isActive" = true`)).toHaveLength(1);
    expect(await seatStatus(seatIds[0]!)).toBe("HELD");
  });

  it("overlapping seat sets in parallel: no deadlock, no seat sold twice", async () => {
    const { eventId, seatIds } = await createEvent(10);
    const users = await createUsers(40);

    // each user wants two neighbouring seats, in a random order
    const results = await race(
      users.map((u, i) => {
        const a = seatIds[i % 9]!;
        const b = seatIds[(i % 9) + 1]!;
        return holdJob(u, eventId, i % 2 === 0 ? [a, b] : [b, a]);
      }),
    );

    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toMatchObject({ code: "SEAT_UNAVAILABLE" }); // never a deadlock error
      }
    }
    const won = results.filter((r) => r.status === "fulfilled").length;
    expect(won).toBeGreaterThan(0);

    const dup = await q(`SELECT "seatId" FROM "BookingItem" WHERE "isActive" = true GROUP BY "seatId" HAVING count(*) > 1`);
    expect(dup).toHaveLength(0);
    const held = await q(`SELECT 1 FROM "Seat" WHERE status = 'HELD'`);
    const items = await q(`SELECT 1 FROM "BookingItem" WHERE "isActive" = true`);
    expect(held).toHaveLength(won * 2);
    expect(items).toHaveLength(won * 2);
  });

  it("the same Idempotency-Key returns the same booking", async () => {
    const { eventId, seatIds } = await createEvent(2);
    const [user] = await createUsers(1);
    const key = "key-12345678";

    const first = await hold(user!, eventId, [seatIds[0]!], key);
    const second = await hold(user!, eventId, [seatIds[0]!], key);

    expect(second.bookingId).toBe(first.bookingId);
    expect(second.replayed).toBe(true);
    expect(await q(`SELECT 1 FROM "Booking"`)).toHaveLength(1);
  });

  it("10 parallel requests with one key create exactly one booking", async () => {
    const { eventId, seatIds } = await createEvent(2);
    const [user] = await createUsers(1);
    const key = "key-parallel-1";

    const settled = await race(Array.from({ length: 10 }, () => holdJob(user!, eventId, [seatIds[0]!], key)));
    const results = settled.map((r) => {
      if (r.status === "rejected") throw r.reason;
      return r.value;
    });

    expect(new Set(results.map((r) => r.bookingId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM "Booking"`)).toHaveLength(1);
  });

  it("rejects an Idempotency-Key reused with different seats", async () => {
    const { eventId, seatIds } = await createEvent(2);
    const [user] = await createUsers(1);
    await hold(user!, eventId, [seatIds[0]!], "key-reused-1");

    await expect(hold(user!, eventId, [seatIds[1]!], "key-reused-1")).rejects.toMatchObject({
      status: 422,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });

  it("allows only one pending booking per user per event", async () => {
    const { eventId, seatIds } = await createEvent(3);
    const [user] = await createUsers(1);
    await hold(user!, eventId, [seatIds[0]!]);

    await expect(hold(user!, eventId, [seatIds[1]!])).rejects.toMatchObject({
      status: 409,
      code: "PENDING_BOOKING_EXISTS",
    });
    expect(await seatStatus(seatIds[1]!)).toBe("AVAILABLE");
  });

  it("refuses a SOLD seat and keeps everything unchanged (all or nothing)", async () => {
    const { eventId, seatIds } = await createEvent(2);
    const [user] = await createUsers(1);
    await q(`UPDATE "Seat" SET status = 'SOLD' WHERE id = $1`, [seatIds[1]]);

    await expect(hold(user!, eventId, [seatIds[0]!, seatIds[1]!])).rejects.toMatchObject({
      status: 409,
      code: "SEAT_UNAVAILABLE",
    });
    expect(await seatStatus(seatIds[0]!)).toBe("AVAILABLE"); // the free seat was NOT taken
    expect(await q(`SELECT 1 FROM "Booking"`)).toHaveLength(0);
  });

  it("rejects seats that belong to another event", async () => {
    const a = await createEvent(1);
    const b = await createEvent(1);
    const [user] = await createUsers(1);

    await expect(hold(user!, a.eventId, [b.seatIds[0]!])).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  });

  it("rejects an event that is not published", async () => {
    const { eventId, seatIds } = await createEvent(1, { status: "DRAFT" });
    const [user] = await createUsers(1);

    await expect(hold(user!, eventId, [seatIds[0]!])).rejects.toMatchObject({ code: "EVENT_NOT_BOOKABLE" });
  });

  it("an expired hold can be taken by someone else, and the old booking is expired", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [alice, bob] = await createUsers(2);
    const old = await hold(alice!, eventId, [seatIds[0]!]);

    // pretend 16 minutes passed (the cleanup job has NOT run)
    await q(`UPDATE "Booking" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [old.bookingId]);
    await q(`UPDATE "Seat" SET "holdExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [seatIds[0]]);

    const fresh = await hold(bob!, eventId, [seatIds[0]!]);

    expect(fresh.bookingId).not.toBe(old.bookingId);
    const [oldBooking] = await q<{ status: string }>(`SELECT status::text AS status FROM "Booking" WHERE id = $1`, [old.bookingId]);
    expect(oldBooking!.status).toBe("EXPIRED");
    const oldItems = await q(`SELECT 1 FROM "BookingItem" WHERE "bookingId" = $1 AND "isActive" = true`, [old.bookingId]);
    expect(oldItems).toHaveLength(0);
    const [seat] = await q<{ currentBookingId: string }>(`SELECT "currentBookingId" FROM "Seat" WHERE id = $1`, [seatIds[0]]);
    expect(seat!.currentBookingId).toBe(fresh.bookingId);
  });

  it("expiry job releases overdue holds, and running it twice is harmless", async () => {
    const { eventId, seatIds } = await createEvent(2);
    const [u1, u2] = await createUsers(2);
    const overdue = await hold(u1!, eventId, [seatIds[0]!]);
    await hold(u2!, eventId, [seatIds[1]!]); // still valid
    await q(`UPDATE "Booking" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [overdue.bookingId]);

    const first = await inTx((sql) => expireDueBookings(sql, new Date().toISOString()));
    const second = await inTx((sql) => expireDueBookings(sql, new Date().toISOString()));

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(await seatStatus(seatIds[0]!)).toBe("AVAILABLE");
    expect(await seatStatus(seatIds[1]!)).toBe("HELD");
    const [b] = await q<{ status: string }>(`SELECT status::text AS status FROM "Booking" WHERE id = $1`, [overdue.bookingId]);
    expect(b!.status).toBe("EXPIRED");
  });

  it("owner can cancel a pending booking and the seats are released", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const { bookingId } = await hold(user!, eventId, [seatIds[0]!]);

    await inTx((sql) => cancelBooking(sql, { bookingId, actor: { id: user!, role: "USER" }, now: new Date() }));

    expect(await seatStatus(seatIds[0]!)).toBe("AVAILABLE");
    const [b] = await q<{ status: string }>(`SELECT status::text AS status FROM "Booking" WHERE id = $1`, [bookingId]);
    expect(b!.status).toBe("CANCELLED");
  });

  it("a stranger cannot cancel (sees 404), an admin can, and cancelling twice is a 409", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [owner, stranger] = await createUsers(2);
    const { bookingId } = await hold(owner!, eventId, [seatIds[0]!]);
    const cancel = (id: string, role: string) =>
      inTx((sql) => cancelBooking(sql, { bookingId, actor: { id, role }, now: new Date() }));

    await expect(cancel(stranger!, "USER")).rejects.toMatchObject({ status: 404 });
    await cancel(stranger!, "ADMIN");
    await expect(cancel(owner!, "USER")).rejects.toMatchObject({ status: 409, code: "INVALID_STATE" });
  });

  it("DB safety net: a second active item for the same seat is refused by the partial unique index", async () => {
    const { eventId, seatIds } = await createEvent(1);
    const [user] = await createUsers(1);
    const { bookingId } = await hold(user!, eventId, [seatIds[0]!]);

    await expect(
      q(`INSERT INTO "BookingItem" (id, "bookingId", "seatId", "priceCents", "isActive") VALUES ($1, $2, $3, 1, true)`, [
        randomUUID(),
        bookingId,
        seatIds[0],
      ]),
    ).rejects.toMatchObject({ code: "23505", constraint: "BookingItem_active_seat_key" });
  });

  it("DB safety net: a HELD seat without a booking is refused by the CHECK constraint", async () => {
    const { seatIds } = await createEvent(1);
    await expect(q(`UPDATE "Seat" SET status = 'HELD' WHERE id = $1`, [seatIds[0]])).rejects.toMatchObject({
      code: "23514",
    });
  });
});