import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Sql } from "../lib/sql.js";

// Shared helpers for tests that run against a REAL PostgreSQL database.
// Use a separate test database: every test starts by emptying the tables.

export function createTestDb(url: string | undefined) {
  const pool = new pg.Pool({ connectionString: url, max: 60 });

  const wrap = (client: pg.PoolClient): Sql => ({
    async query(sql, params = []) {
      return (await client.query(sql, params)).rows;
    },
    async execute(sql, params = []) {
      return (await client.query(sql, params)).rowCount ?? 0;
    },
  });

  // One transaction, like the production code.
  async function inTx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(wrap(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // Really simultaneous transactions: every connection is opened and BEGIN-ed first,
  // then a gate opens and all jobs start at the same moment.
  async function race<T>(jobs: Array<(sql: Sql) => Promise<T>>) {
    const clients = await Promise.all(jobs.map(() => pool.connect()));
    try {
      await Promise.all(clients.map((c) => c.query("BEGIN")));
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => (openGate = resolve));

      const runs = jobs.map(async (job, i) => {
        const client = clients[i]!;
        await gate;
        try {
          const result = await job(wrap(client));
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      });

      openGate();
      return await Promise.allSettled(runs);
    } finally {
      clients.forEach((c) => c.release());
    }
  }

  // Like race(), but every job opens (and may retry) its own transaction, as the services do.
  async function raceTx<T>(jobs: Array<() => Promise<T>>) {
    const warm = await Promise.all(jobs.map(() => pool.connect()));
    warm.forEach((c) => c.release());

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    const runs = jobs.map(async (job) => {
      await gate;
      return job();
    });
    openGate();
    return Promise.allSettled(runs);
  }

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows as T[];

  async function createUsers(n: number) {
    const ids = Array.from({ length: n }, () => randomUUID());
    for (const id of ids) {
      await q(`INSERT INTO "User" (id, name, email, "updatedAt") VALUES ($1, 'User', $2, now())`, [id, `${id}@test.dev`]);
    }
    return ids;
  }

  async function createEvent(seatCount: number, opts: { priceCents?: number; status?: string } = {}) {
    const [organizer] = await createUsers(1);
    const eventId = randomUUID();
    const tierId = randomUUID();
    await q(
      `INSERT INTO "Event" (id, "organizerId", title, venue, "startsAt", "endsAt", status, "updatedAt")
       VALUES ($1, $2, 'Test Event', 'Hall',
               (now() AT TIME ZONE 'UTC') + interval '10 days', (now() AT TIME ZONE 'UTC') + interval '11 days',
               $3::"EventStatus", now())`,
      [eventId, organizer, opts.status ?? "PUBLISHED"],
    );
    await q(`INSERT INTO "TicketTier" (id, "eventId", name, "priceCents", currency) VALUES ($1, $2, 'Regular', $3, 'USD')`, [
      tierId,
      eventId,
      opts.priceCents ?? 5000,
    ]);
    const seatIds: string[] = [];
    for (let i = 1; i <= seatCount; i++) {
      const id = randomUUID();
      seatIds.push(id);
      await q(`INSERT INTO "Seat" (id, "eventId", "tierId", section, "row", number) VALUES ($1, $2, $3, 'A', '1', $4)`, [
        id,
        eventId,
        tierId,
        i,
      ]);
    }
    return { eventId, tierId, seatIds };
  }

  const seatStatus = async (id: string) =>
    (await q<{ status: string }>(`SELECT status::text AS status FROM "Seat" WHERE id = $1`, [id]))[0]!.status;

  const reset = () => q(`TRUNCATE "User" CASCADE`).then(() => q(`TRUNCATE "WebhookEvent"`));

  return { pool, q, inTx, race, raceTx, createUsers, createEvent, seatStatus, reset, close: () => pool.end() };
}