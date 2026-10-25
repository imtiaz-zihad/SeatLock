import { describe, expect, it } from "vitest";
import { bulkSeatsSchema, listSeatsQuerySchema } from "./seat.schemas.js";

const tierId = "22222222-2222-4222-8222-222222222222";

describe("bulkSeatsSchema", () => {
  const valid = { tierId, section: "A", rows: ["1", "2", "3"], seatsPerRow: 10 };

  it("accepts a valid request and defaults startNumber to 1", () => {
    expect(bulkSeatsSchema.parse(valid).startNumber).toBe(1);
  });

  it("rejects duplicate rows", () => {
    expect(bulkSeatsSchema.safeParse({ ...valid, rows: ["1", "1"] }).success).toBe(false);
  });

  it("rejects more than 2000 seats in one request", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `R${i}`);
    expect(bulkSeatsSchema.safeParse({ ...valid, rows, seatsPerRow: 100 }).success).toBe(false);
  });

  it("rejects an empty rows list", () => {
    expect(bulkSeatsSchema.safeParse({ ...valid, rows: [] }).success).toBe(false);
  });

  it("rejects a tierId that is not a uuid", () => {
    expect(bulkSeatsSchema.safeParse({ ...valid, tierId: "x" }).success).toBe(false);
  });
});

describe("listSeatsQuerySchema", () => {
  it("accepts an empty query", () => {
    expect(listSeatsQuerySchema.safeParse({}).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(listSeatsQuerySchema.safeParse({ status: "BROKEN" }).success).toBe(false);
  });
});
