import { randomUUID } from "node:crypto";
import type { Sql } from "./sql.js";

export type AuditEntry = {
  actorId: string | null;
  action: string;
  entityType: string; // "Booking", "Payment", "Event", ...
  entityId: string;
  metadata?: unknown;
};

const CHUNK = 500; // 500 rows x 6 parameters = 3000 parameters per statement (databases limit this)

// Writes audit rows. Call it inside the same transaction as the change.
export async function writeAudit(sql: Sql, nowIso: string, entries: AuditEntry[]) {
  for (let from = 0; from < entries.length; from += CHUNK) {
    await insertChunk(sql, nowIso, entries.slice(from, from + CHUNK));
  }
}

async function insertChunk(sql: Sql, nowIso: string, entries: AuditEntry[]) {
  const last = entries.length * 6 + 1; // index of the timestamp parameter
  const values = entries.map((_, i) => {
    const n = i * 6;
    return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}::jsonb, ($${last}::timestamptz AT TIME ZONE 'UTC'))`;
  });
  const params = entries.flatMap((e) => [
    randomUUID(),
    e.actorId,
    e.action,
    e.entityType,
    e.entityId,
    e.metadata === undefined ? null : JSON.stringify(e.metadata),
  ]);

  await sql.execute(
    `INSERT INTO "AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt") VALUES ${values.join(", ")}`,
    [...params, nowIso],
  );
}