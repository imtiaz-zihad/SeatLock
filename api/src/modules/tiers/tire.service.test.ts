import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tier.repository.js", () => ({
  create: vi.fn(),
  listByEvent: vi.fn(),
  findInEvent: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  countSeats: vi.fn(),
  countLockedSeats: vi.fn(),
}));

vi.mock("../events/event.service.js", () => ({
  getEvent: vi.fn(),
  getManageableEvent: vi.fn(),
}));

import * as eventService from "../events/event.service.js";
import * as repo from "./tire.repository.js";
import * as service from "./tire.service.js";

const owner = { id: "owner-1", role: "ORGANIZER" };
const eventId = "11111111-1111-4111-8111-111111111111";
const tierId = "22222222-2222-4222-8222-222222222222";

const events = vi.mocked(eventService);
const tiers = vi.mocked(repo);

const draftEvent = { id: eventId, organizerId: "owner-1", status: "DRAFT" };
const tier = { id: tierId, eventId, name: "VIP", priceCents: 15000, currency: "USD" };

beforeEach(() => {
  vi.resetAllMocks();
  events.getManageableEvent.mockResolvedValue(draftEvent as never);
});

describe("listTiers", () => {
  it("checks event visibility first, then lists", async () => {
    events.getEvent.mockResolvedValue(draftEvent as never);
    tiers.listByEvent.mockResolvedValue([tier] as never);

    const result = await service.listTiers(eventId, null);

    expect(events.getEvent).toHaveBeenCalledWith(eventId, null);
    expect(result).toHaveLength(1);
  });

  it("does not list tiers of a hidden event", async () => {
    events.getEvent.mockRejectedValue({ status: 404 });
    await expect(service.listTiers(eventId, null)).rejects.toMatchObject({ status: 404 });
    expect(tiers.listByEvent).not.toHaveBeenCalled();
  });
});

describe("createTier", () => {
  it("creates a tier", async () => {
    tiers.create.mockResolvedValue(tier as never);
    await service.createTier(eventId, owner, { name: "VIP", priceCents: 15000, currency: "USD" });
    expect(tiers.create).toHaveBeenCalledWith(eventId, { name: "VIP", priceCents: 15000, currency: "USD" });
  });

  it("turns a duplicate name into 409 TIER_NAME_TAKEN", async () => {
    tiers.create.mockRejectedValue({ code: "P2002" });
    await expect(
      service.createTier(eventId, owner, { name: "VIP", priceCents: 1, currency: "USD" }),
    ).rejects.toMatchObject({ status: 409, code: "TIER_NAME_TAKEN" });
  });

  it("lets unknown errors through", async () => {
    tiers.create.mockRejectedValue(new Error("db down"));
    await expect(
      service.createTier(eventId, owner, { name: "VIP", priceCents: 1, currency: "USD" }),
    ).rejects.toThrow("db down");
  });

  it("refuses to add a tier to a cancelled event", async () => {
    events.getManageableEvent.mockResolvedValue({ ...draftEvent, status: "CANCELLED" } as never);
    await expect(
      service.createTier(eventId, owner, { name: "VIP", priceCents: 1, currency: "USD" }),
    ).rejects.toMatchObject({ status: 409, code: "EVENT_NOT_EDITABLE" });
  });
});

describe("updateTier", () => {
  beforeEach(() => {
    tiers.findInEvent.mockResolvedValue(tier as never);
  });

  it("changes the price when no seat is held or sold", async () => {
    tiers.countLockedSeats.mockResolvedValue(0 as never);
    tiers.update.mockResolvedValue(tier as never);

    await service.updateTier(eventId, tierId, owner, { priceCents: 20000 });

    expect(tiers.update).toHaveBeenCalledWith(tierId, { priceCents: 20000 });
  });

  it("blocks a price change when seats are held or sold", async () => {
    tiers.countLockedSeats.mockResolvedValue(3 as never);
    await expect(service.updateTier(eventId, tierId, owner, { priceCents: 20000 })).rejects.toMatchObject({
      status: 409,
      code: "TIER_IN_USE",
    });
    expect(tiers.update).not.toHaveBeenCalled();
  });

  it("allows a rename even when seats are sold", async () => {
    tiers.update.mockResolvedValue(tier as never);
    await service.updateTier(eventId, tierId, owner, { name: "Gold" });
    expect(tiers.countLockedSeats).not.toHaveBeenCalled();
    expect(tiers.update).toHaveBeenCalled();
  });

  it("returns 404 for a tier of another event", async () => {
    tiers.findInEvent.mockResolvedValue(null as never);
    await expect(service.updateTier(eventId, tierId, owner, { name: "X" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("deleteTier", () => {
  beforeEach(() => {
    tiers.findInEvent.mockResolvedValue(tier as never);
  });

  it("deletes an empty tier", async () => {
    tiers.countSeats.mockResolvedValue(0 as never);
    await service.deleteTier(eventId, tierId, owner);
    expect(tiers.remove).toHaveBeenCalledWith(tierId);
  });

  it("refuses to delete a tier that has seats", async () => {
    tiers.countSeats.mockResolvedValue(40 as never);
    await expect(service.deleteTier(eventId, tierId, owner)).rejects.toMatchObject({
      status: 409,
      code: "TIER_HAS_SEATS",
    });
    expect(tiers.remove).not.toHaveBeenCalled();
  });
});
