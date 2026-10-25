import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./seat.repository.js", () => ({
  createMany: vi.fn(),
  listByEvent: vi.fn(),
}));

vi.mock("../tiers/tier.repository.js", () => ({
  findInEvent: vi.fn(),
}));

vi.mock("../events/event.service.js", () => ({
  getEvent: vi.fn(),
  getManageableEvent: vi.fn(),
}));

import * as eventService from "../events/event.service.js";
import * as tierRepo from "../tiers/tire.repository.js";
import * as repo from "./seat.repository.js";
import * as service from "./seat.service.js";

const owner = { id: "owner-1", role: "ORGANIZER" };
const eventId = "11111111-1111-4111-8111-111111111111";
const tierId = "22222222-2222-4222-8222-222222222222";

const events = vi.mocked(eventService);
const seatRepo = vi.mocked(repo);
const tiers = vi.mocked(tierRepo);

const minute = 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
  events.getManageableEvent.mockResolvedValue({ id: eventId, organizerId: "owner-1", status: "DRAFT" } as never);
  events.getEvent.mockResolvedValue({ id: eventId, status: "PUBLISHED" } as never);
  tiers.findInEvent.mockResolvedValue({ id: tierId, eventId } as never);
});

describe("effectiveSeatStatus", () => {
  const now = new Date();

  it("keeps a live hold as HELD", () => {
    const seat = { status: "HELD", holdExpiresAt: new Date(now.getTime() + 5 * minute) };
    expect(service.effectiveSeatStatus(seat, now)).toBe("HELD");
  });

  it("treats an expired hold as AVAILABLE", () => {
    const seat = { status: "HELD", holdExpiresAt: new Date(now.getTime() - minute) };
    expect(service.effectiveSeatStatus(seat, now)).toBe("AVAILABLE");
  });

  it("never frees a SOLD seat", () => {
    const seat = { status: "SOLD", holdExpiresAt: new Date(now.getTime() - minute) };
    expect(service.effectiveSeatStatus(seat, now)).toBe("SOLD");
  });
});

describe("generateSeats", () => {
  it("builds rows x seatsPerRow seats with correct numbering", async () => {
    seatRepo.createMany.mockResolvedValue({ count: 6 } as never);

    const result = await service.generateSeats(eventId, owner, {
      tierId,
      section: "A",
      rows: ["1", "2"],
      seatsPerRow: 3,
      startNumber: 5,
    });

    expect(result).toEqual({ created: 6 });
    const sent = seatRepo.createMany.mock.calls[0]![0];
    expect(sent).toHaveLength(6);
    expect(sent[0]).toEqual({ eventId, tierId, section: "A", row: "1", number: 5 });
    expect(sent[5]).toEqual({ eventId, tierId, section: "A", row: "2", number: 7 });
  });

  it("rejects a tier that belongs to another event", async () => {
    tiers.findInEvent.mockResolvedValue(null as never);
    await expect(
      service.generateSeats(eventId, owner, { tierId, section: "A", rows: ["1"], seatsPerRow: 2, startNumber: 1 }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(seatRepo.createMany).not.toHaveBeenCalled();
  });

  it("turns a unique clash into 409 SEAT_CONFLICT", async () => {
    seatRepo.createMany.mockRejectedValue({ code: "P2002" });
    await expect(
      service.generateSeats(eventId, owner, { tierId, section: "A", rows: ["1"], seatsPerRow: 2, startNumber: 1 }),
    ).rejects.toMatchObject({ status: 409, code: "SEAT_CONFLICT" });
  });

  it("refuses to add seats to a cancelled event", async () => {
    events.getManageableEvent.mockResolvedValue({ id: eventId, organizerId: "owner-1", status: "CANCELLED" } as never);
    await expect(
      service.generateSeats(eventId, owner, { tierId, section: "A", rows: ["1"], seatsPerRow: 2, startNumber: 1 }),
    ).rejects.toMatchObject({ status: 409, code: "EVENT_NOT_EDITABLE" });
  });
});

describe("getSeatMap", () => {
  const future = new Date(Date.now() + 10 * minute);
  const past = new Date(Date.now() - 10 * minute);

  const rows = [
    { id: "s1", section: "A", row: "10", number: 1, tierId, status: "AVAILABLE", holdExpiresAt: null },
    { id: "s2", section: "A", row: "2", number: 2, tierId, status: "SOLD", holdExpiresAt: null },
    { id: "s3", section: "A", row: "2", number: 1, tierId, status: "HELD", holdExpiresAt: future },
    { id: "s4", section: "A", row: "2", number: 3, tierId, status: "HELD", holdExpiresAt: past },
    { id: "s5", section: "B", row: "1", number: 1, tierId, status: "AVAILABLE", holdExpiresAt: null },
  ];

  it("groups by section and row, sorts naturally and counts", async () => {
    seatRepo.listByEvent.mockResolvedValue(rows as never);

    const map = await service.getSeatMap(eventId, null, {});

    expect(map.summary).toEqual({ total: 5, available: 3, held: 1, sold: 1 }); // s4 expired -> available
    expect(map.sections.map((s) => s.section)).toEqual(["A", "B"]);
    expect(map.sections[0]!.rows.map((r) => r.row)).toEqual(["2", "10"]); // 2 before 10
    expect(map.sections[0]!.rows[0]!.seats.map((s) => s.number)).toEqual([1, 2, 3]);
  });

  it("filters by effective status", async () => {
    seatRepo.listByEvent.mockResolvedValue(rows as never);

    const map = await service.getSeatMap(eventId, null, { status: "AVAILABLE" });

    expect(map.summary.total).toBe(3);
    expect(map.sections.flatMap((s) => s.rows).flatMap((r) => r.seats).every((s) => s.status === "AVAILABLE")).toBe(true);
  });

  it("does not expose seats of a hidden event", async () => {
    events.getEvent.mockRejectedValue({ status: 404 });
    await expect(service.getSeatMap(eventId, null, {})).rejects.toMatchObject({ status: 404 });
    expect(seatRepo.listByEvent).not.toHaveBeenCalled();
  });
});
