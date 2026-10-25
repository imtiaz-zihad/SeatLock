import type { Request, Response } from "express";
import { getActor } from "../../middlewares/auth.js";
import * as service from "./event.service.js";
import type { CreateEventInput, ListEventsQuery, UpdateEventInput } from "./event.schemas.js";

// Controllers only translate HTTP <-> service calls.
// requireAuth guarantees an actor on protected routes, hence the "!".

type Validated<T> = { validated: T };

export async function list(_req: Request, res: Response) {
  const { query } = (res.locals as Validated<{ query: ListEventsQuery }>).validated;
  res.json(await service.listEvents(query));
}

export async function getById(_req: Request, res: Response) {
  const { params } = (res.locals as Validated<{ params: { id: string } }>).validated;
  res.json({ data: await service.getEvent(params.id, getActor(res)) });
}

export async function create(_req: Request, res: Response) {
  const { body } = (res.locals as Validated<{ body: CreateEventInput }>).validated;
  const event = await service.createEvent(getActor(res)!, body);
  res.status(201).json({ data: event });
}

export async function update(_req: Request, res: Response) {
  const { params, body } = (res.locals as Validated<{ params: { id: string }; body: UpdateEventInput }>).validated;
  res.json({ data: await service.updateEvent(params.id, getActor(res)!, body) });
}

export async function publish(_req: Request, res: Response) {
  const { params } = (res.locals as Validated<{ params: { id: string } }>).validated;
  res.json({ data: await service.publishEvent(params.id, getActor(res)!) });
}

export async function cancel(_req: Request, res: Response) {
  const { params } = (res.locals as Validated<{ params: { id: string } }>).validated;
  res.json({ data: await service.cancelEvent(params.id, getActor(res)!) });
}

export async function remove(_req: Request, res: Response) {
  const { params } = (res.locals as Validated<{ params: { id: string } }>).validated;
  await service.deleteEvent(params.id, getActor(res)!);
  res.status(204).send();
}
