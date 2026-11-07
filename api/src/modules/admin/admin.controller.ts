import type { Request, Response } from "express";
import * as service from "./admin.service.js";
import type { ListAuditLogsQuery } from "./admin.schemas.js";

type Validated<T> = { validated: T };

export async function stats(_req: Request, res: Response) {
  res.json({ data: await service.getStats() });
}

export async function auditLogs(_req: Request, res: Response) {
  const { query } = (res.locals as Validated<{ query: ListAuditLogsQuery }>).validated;
  res.json(await service.listAuditLogs(query));
}