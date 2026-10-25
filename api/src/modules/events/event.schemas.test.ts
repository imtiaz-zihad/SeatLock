import { describe, expect, it } from "vitest";
import { createEventSchema, listEventsQuerySchema, updateEventSchema } from "./event.schemas.js";

const day = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * day).toISOString();

describe("createEventSchema", () => {
  const valid = {
    title: "Rock Night",
    venue: "City Arena",
    startsAt: inDays(10),
    endsAt: inDays(11),
  };

  it("accepts a valid event and turns dates into Date objects", () => {
    const result = createEventSchema.parse(valid);
    expect(result.startsAt).toBeInstanceOf(Date);
  });

  it("rejects endsAt before startsAt", () => {
    const result = createEventSchema.safeParse({ ...valid, endsAt: inDays(9) });
    expect(result.success).toBe(false);
  });

  it("rejects a start date in the past", () => {
    const result = createEventSchema.safeParse({ ...valid, startsAt: inDays(-2), endsAt: inDays(-1) });
    expect(result.success).toBe(false);
  });

  it("rejects a too-short title", () => {
    expect(createEventSchema.safeParse({ ...valid, title: "ab" }).success).toBe(false);
  });
});

describe("updateEventSchema", () => {
  it("allows a partial update", () => {
    expect(updateEventSchema.safeParse({ title: "New title" }).success).toBe(true);
  });

  it("rejects an empty update", () => {
    expect(updateEventSchema.safeParse({}).success).toBe(false);
  });
});

describe("listEventsQuerySchema", () => {
  it("defaults limit to 20", () => {
    expect(listEventsQuerySchema.parse({}).limit).toBe(20);
  });

  it("rejects limit above 50", () => {
    expect(listEventsQuerySchema.safeParse({ limit: "999" }).success).toBe(false);
  });

  it("rejects a cursor that is not a uuid", () => {
    expect(listEventsQuerySchema.safeParse({ cursor: "abc" }).success).toBe(false);
  });
});
