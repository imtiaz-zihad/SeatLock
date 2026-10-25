import type { Request, Response } from "express";
import { getActor } from "../../middlewares/auth.js";
import * as service from "./seat.service.js";
import type { BulkSeatsInput, ListSeatsQuery } from "./seat.schemas.js";

type Validated<T> = { validated: T };

export async function generate(_req: Request, res: Response) {
  const { params, body } = (res.locals as Validated<{ params: { id: string }; body: BulkSeatsInput }>).validated;
  const result = await service.generateSeats(params.id, getActor(res)!, body);
  res.status(201).json({ data: result });
}

export async function seatMap(_req: Request, res: Response) {
  const { params, query } = (res.locals as Validated<{ params: { id: string }; query: ListSeatsQuery }>).validated;
  res.json({ data: await service.getSeatMap(params.id, getActor(res), query) });
}
