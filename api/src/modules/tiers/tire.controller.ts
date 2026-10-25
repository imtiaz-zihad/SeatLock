import type { Request, Response } from "express";
import { getActor } from "../../middlewares/auth.js";
import * as service from "./tire.service.js";
import type { CreateTierInput, UpdateTierInput } from "./tire.schemas.js";

type Validated<T> = { validated: T };

export async function list(_req: Request, res: Response) {
  const { params } = (res.locals as Validated<{ params: { id: string } }>).validated;
  res.json({ data: await service.listTiers(params.id, getActor(res)) });
}

export async function create(_req: Request, res: Response) {
  const { params, body } = (res.locals as Validated<{ params: { id: string }; body: CreateTierInput }>).validated;
  const tier = await service.createTier(params.id, getActor(res)!, body);
  res.status(201).json({ data: tier });
}

export async function update(_req: Request, res: Response) {
  const { params, body } = (
    res.locals as Validated<{ params: { id: string; tierId: string }; body: UpdateTierInput }>
  ).validated;
  res.json({ data: await service.updateTier(params.id, params.tierId, getActor(res)!, body) });
}

export async function remove(_req: Request, res: Response) {
  const { params } = (res.locals as Validated<{ params: { id: string; tierId: string } }>).validated;
  await service.deleteTier(params.id, params.tierId, getActor(res)!);
  res.status(204).send();
}
