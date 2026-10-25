import { AppError } from "../../lib/errors.js";
import { isUniqueViolation } from "../../lib/prisma-error.js";
import type { Actor } from "../../lib/types.js";
import { assertEventOpen } from "../events/event.rules.js";
import * as eventService from "../events/event.service.js";
import * as repo from "./tire.repository.js";
import type { CreateTierInput, UpdateTierInput } from "./tire.schemas.js";

const nameTaken = () => AppError.conflict("TIER_NAME_TAKEN", "This event already has a tier with that name");

async function getTierOrThrow(tierId: string, eventId: string) {
  const tier = await repo.findInEvent(tierId, eventId);
  if (!tier) throw AppError.notFound("Tier");
  return tier;
}

// Same visibility as the event itself.
export async function listTiers(eventId: string, actor: Actor | null) {
  await eventService.getEvent(eventId, actor);
  return repo.listByEvent(eventId);
}

export async function createTier(eventId: string, actor: Actor, input: CreateTierInput) {
  const event = await eventService.getManageableEvent(eventId, actor);
  assertEventOpen(event);

  try {
    return await repo.create(eventId, input);
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

export async function updateTier(eventId: string, tierId: string, actor: Actor, input: UpdateTierInput) {
  const event = await eventService.getManageableEvent(eventId, actor);
  assertEventOpen(event);
  const tier = await getTierOrThrow(tierId, eventId);

  // Changing the price while seats are held or sold would make existing bookings inconsistent.
  if (input.priceCents !== undefined && input.priceCents !== tier.priceCents) {
    if ((await repo.countLockedSeats(tierId)) > 0) {
      throw AppError.conflict("TIER_IN_USE", "Price cannot change while seats are held or sold");
    }
  }

  try {
    return await repo.update(tierId, input);
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

export async function deleteTier(eventId: string, tierId: string, actor: Actor) {
  const event = await eventService.getManageableEvent(eventId, actor);
  assertEventOpen(event);
  await getTierOrThrow(tierId, eventId);

  if ((await repo.countSeats(tierId)) > 0) {
    throw AppError.conflict("TIER_HAS_SEATS", "Remove or reassign the seats of this tier first");
  }

  await repo.remove(tierId);
}
