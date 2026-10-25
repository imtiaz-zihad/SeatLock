import { AppError } from "../../lib/errors.js";
import { toPage } from "../../lib/pagination.js";
import type { Actor } from "../../lib/types.js";
import * as repo from "./event.repository.js";
import type { CreateEventInput, ListEventsQuery, UpdateEventInput } from "./event.schemas.js";

// Business rules live here. No Express, no direct Prisma.

function canManage(event: { organizerId: string }, actor: Actor | null) {
  if (!actor) return false;
  return actor.role === "ADMIN" || event.organizerId === actor.id;
}

function assertCanManage(event: { organizerId: string }, actor: Actor) {
  if (!canManage(event, actor)) {
    throw AppError.forbidden("You can only manage your own events");
  }
}

async function getOrThrow(id: string) {
  const event = await repo.findById(id);
  if (!event) throw AppError.notFound("Event");
  return event;
}

export async function createEvent(actor: Actor, input: CreateEventInput) {
  return repo.create(actor.id, input);
}

export async function listEvents(query: ListEventsQuery) {
  const rows = await repo.listPublished(query);
  return toPage(rows, query.limit);
}

// Drafts and cancelled events are hidden from everyone except the owner and admins.
// They get a 404 (not 403) so outsiders cannot even tell the event exists.
export async function getEvent(id: string, actor: Actor | null) {
  const event = await getOrThrow(id);

  if (event.status !== "PUBLISHED" && !canManage(event, actor)) {
    throw AppError.notFound("Event");
  }
  return event;
}

export async function updateEvent(id: string, actor: Actor, input: UpdateEventInput) {
  const event = await getOrThrow(id);
  assertCanManage(event, actor);

  if (event.status === "CANCELLED" || event.status === "COMPLETED") {
    throw AppError.conflict("EVENT_NOT_EDITABLE", `A ${event.status.toLowerCase()} event cannot be edited`);
  }

  // The new dates must make sense together with the stored ones.
  const startsAt = input.startsAt ?? event.startsAt;
  const endsAt = input.endsAt ?? event.endsAt;
  if (endsAt <= startsAt) {
    throw AppError.validation([{ path: "body.endsAt", message: "endsAt must be after startsAt" }]);
  }

  return repo.update(id, input);
}

export async function publishEvent(id: string, actor: Actor) {
  const event = await getOrThrow(id);
  assertCanManage(event, actor);

  if (event.status !== "DRAFT") {
    throw AppError.conflict("INVALID_STATE", "Only a draft event can be published");
  }
  if (event.startsAt <= new Date()) {
    throw AppError.conflict("EVENT_IN_PAST", "An event that already started cannot be published");
  }
  // Later: require at least one tier and one seat before publishing.

  return repo.update(id, { status: "PUBLISHED" });
}

export async function cancelEvent(id: string, actor: Actor) {
  const event = await getOrThrow(id);
  assertCanManage(event, actor);

  if (event.status !== "DRAFT" && event.status !== "PUBLISHED") {
    throw AppError.conflict("INVALID_STATE", "Only a draft or published event can be cancelled");
  }
  // Later: refund all confirmed bookings of this event.

  return repo.update(id, { status: "CANCELLED" });
}

export async function deleteEvent(id: string, actor: Actor) {
  const event = await getOrThrow(id);
  assertCanManage(event, actor);

  if (event.status === "PUBLISHED" || event.status === "COMPLETED") {
    throw AppError.conflict("INVALID_STATE", "Cancel the event before deleting it");
  }

  await repo.softDelete(id);
}
