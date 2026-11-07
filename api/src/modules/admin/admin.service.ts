import { toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { prismaSql } from "../../lib/sql.js";
import * as core from "./admin.core.js";
import type { ListAuditLogsQuery } from "./admin.schemas.js";

export function getStats() {
  return core.getStats(prismaSql(prisma), new Date().toISOString());
}

export async function listAuditLogs(query: ListAuditLogsQuery) {
  const rows = await core.listAuditLogs(prismaSql(prisma), query);
  return toPage(rows, query.limit);
}