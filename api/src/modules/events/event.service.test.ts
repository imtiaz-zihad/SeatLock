import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace the repository so these tests never touch a database.
vi.mock("./event.repository.js", () => ({
  create: vi.fn(),
  findById: vi.fn(),
  listPublished: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
}));

import * as repo from "./event.repository.js";
import * as service from "./event.service.js";

const day = 24 * 60 * 60 * 1000;
const owner = { id: "owner-1", role: "ORGANIZER" };
const stranger = { id: "other-9", role: "ORGANIZER" };
const admin = { id: "admin-1", role: "ADMIN" };

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organizerId: "owner-1",
    title: "Rock Night",
    venue: "City Arena",
    status: "DRAFT",
    startsAt: new Date(Date.now() + 10 * day),
    endsAt: new Date(Date.now() + 11 * day),
    deletedAt: null,
    ...overrides,
  };
}

const id = "11111111-1111-4111-8111-111111111111";
const mocked = vi.mocked(repo);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("createEvent", () => {
  it("creates the event for the logged-in organizer", async () => {
    mocked.create.mockResolvedValue(makeEvent() as never);
    const input = { title: "Rock Night", venue: "City Arena", startsAt: new Date(), endsAt: new Date() };

    await service.createEvent(owner, input);

    expect(mocked.create).toHaveBeenCalledWith("owner-1", input);
  });
});

describe("listEvents", () => {
  it("returns a page and a next cursor when more rows exist", async () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    mocked.listPublished.mockResolvedValue(rows as never);

    const page = await service.listEvents({ limit: 2 });

    expect(page.data).toHaveLength(2);
    expect(page.pageInfo).toEqual({ nextCursor: "b", hasMore: true });
  });

  it("has no next cursor on the last page", async () => {
    mocked.listPublished.mockResolvedValue([{ id: "a" }] as never);

    const page = await service.listEvents({ limit: 2 });

    expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
  });
});

describe("getEvent", () => {
  it("returns 404 when the event does not exist", async () => {
    mocked.findById.mockResolvedValue(null as never);
    await expect(service.getEvent(id, null)).rejects.toMatchObject({ status: 404 });
  });

  it("shows a published event to anonymous visitors", async () => {
    mocked.findById.mockResolvedValue(makeEvent({ status: "PUBLISHED" }) as never);
    await expect(service.getEvent(id, null)).resolves.toMatchObject({ status: "PUBLISHED" });
  });

  it("hides a draft from strangers with a 404", async () => {
    mocked.findById.mockResolvedValue(makeEvent() as never);
    await expect(service.getEvent(id, stranger)).rejects.toMatchObject({ status: 404 });
  });

  it("shows a draft to its owner and to admins", async () => {
    mocked.findById.mockResolvedValue(makeEvent() as never);
    await expect(service.getEvent(id, owner)).resolves.toBeDefined();
    await expect(service.getEvent(id, admin)).resolves.toBeDefined();
  });
});

describe("updateEvent", () => {
  it("forbids another organizer", async () => {
    mocked.findById.mockResolvedValue(makeEvent() as never);
    await expect(service.updateEvent(id, stranger, { title: "Hacked" })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    expect(mocked.update).not.toHaveBeenCalled();
  });

  it("allows an admin", async () => {
    mocked.findById.mockResolvedValue(makeEvent() as never);
    mocked.update.mockResolvedValue(makeEvent() as never);
    await service.updateEvent(id, admin, { title: "Fixed by admin" });
    expect(mocked.update).toHaveBeenCalledWith(id, { title: "Fixed by admin" });
  });

  it("rejects editing a cancelled event", async () => {
    mocked.findById.mockResolvedValue(makeEvent({ status: "CANCELLED" }) as never);
    await expect(service.updateEvent(id, owner, { title: "Nope" })).rejects.toMatchObject({
      status: 409,
      code: "EVENT_NOT_EDITABLE",
    });
  });

  it("rejects an end date before the stored start date", async () => {
    mocked.findById.mockResolvedValue(makeEvent() as never);
    const tooEarly = new Date(Date.now() + 1 * day);
    await expect(service.updateEvent(id, owner, { endsAt: tooEarly })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
  });
});

describe("publishEvent", () => {
  it("publishes a draft", async () => {
    mocked.findById.mockResolvedValue(makeEvent() as never);
    mocked.update.mockResolvedValue(makeEvent({ status: "PUBLISHED" }) as never);

    await service.publishEvent(id, owner);

    expect(mocked.update).toHaveBeenCalledWith(id, { status: "PUBLISHED" });
  });

  it("refuses to publish twice", async () => {
    mocked.findById.mockResolvedValue(makeEvent({ status: "PUBLISHED" }) as never);
    await expect(service.publishEvent(id, owner)).rejects.toMatchObject({ status: 409, code: "INVALID_STATE" });
  });

  it("refuses to publish an event that already started", async () => {
    mocked.findById.mockResolvedValue(makeEvent({ startsAt: new Date(Date.now() - day) }) as never);
    await expect(service.publishEvent(id, owner)).rejects.toMatchObject({ status: 409, code: "EVENT_IN_PAST" });
  });
});

describe("cancelEvent", () => {
  it("cancels a published event", async () => {
    mocked.findById.mockResolvedValue(makeEvent({ status: "PUBLISHED" }) as never);
    mocked.update.mockResolvedValue(makeEvent({ status: "CANCELLED" }) as never);

    await service.cancelEvent(id, owner);

    expect(mocked.update).toHaveBeenCalledWith(id, { status: "CANCELLED" });
  });

  it("cannot cancel twice", async () => {
    mocked.findById.mockResolvedValue(makeEvent({ status: "CANCELLED" }) as never);
    await expect(service.cancelEvent(id, owner)).rejects.toMatchObject({ status: 409 });
  });
});

describe("deleteEvent", () => {
  it("soft-deletes a draft", async () => {
    mocked.findById.mockResolvedValue(makeEvent() as never);
    await service.deleteEvent(id, owner);
    expect(mocked.softDelete).toHaveBeenCalledWith(id);
  });

  it("refuses to delete a published event", async () => {
    mocked.findById.mockResolvedValue(makeEvent({ status: "PUBLISHED" }) as never);
    await expect(service.deleteEvent(id, owner)).rejects.toMatchObject({ status: 409 });
    expect(mocked.softDelete).not.toHaveBeenCalled();
  });
});
