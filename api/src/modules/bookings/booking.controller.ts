import type { Request, Response } from "express";
import { getActor } from "../../middlewares/auth.js";
import * as service from "./booking.service.js";
import type { CreateBookingInput, ListBookingsQuery } from "./booking.schemas.js";

type Validated<T> = { validated: T };

export async function create(_req: Request, res: Response) {
  const { headers, body } = (
    res.locals as Validated<{ headers: { "idempotency-key": string }; body: CreateBookingInput }>
  ).validated;

  const { booking, replayed } = await service.createBooking(getActor(res)!, headers["idempotency-key"], body);

  // 201 = new booking, 200 = the same request was already processed (safe retry)
  res.status(replayed ? 200 : 201).set("Idempotent-Replayed", String(replayed)).json({ data: booking });
}

export async function list(_req: Request, res: Response) {
  const { query } = (res.locals as Validated<{ query: ListBookingsQuery }>).validated;
  res.json(await service.listMyBookings(getActor(res)!, query));
}

export async function getById(_req: Request, res: Response) {
  const { params } = (res.locals as Validated<{ params: { id: string } }>).validated;
  res.json({ data: await service.getBooking(getActor(res)!, params.id) });
}

export async function cancel(_req: Request, res: Response) {
  const { params } = (res.locals as Validated<{ params: { id: string } }>).validated;
  res.json({ data: await service.cancelBooking(getActor(res)!, params.id) });
}
