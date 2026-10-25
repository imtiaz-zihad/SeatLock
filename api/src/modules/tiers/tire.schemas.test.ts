import { describe, expect, it } from "vitest";
import { createTierSchema, updateTierSchema } from "./tire.schemas.js"

describe("createTierSchema", () => {
  it("accepts a valid tier and defaults currency to USD", () => {
    const tier = createTierSchema.parse({ name: "VIP", priceCents: 15000 });
    expect(tier.currency).toBe("USD");
  });

  it("rejects a decimal price (money must be whole cents)", () => {
    expect(createTierSchema.safeParse({ name: "VIP", priceCents: 10.5 }).success).toBe(false);
  });

  it("rejects a negative price", () => {
    expect(createTierSchema.safeParse({ name: "VIP", priceCents: -1 }).success).toBe(false);
  });

  it("rejects an unknown currency", () => {
    expect(createTierSchema.safeParse({ name: "VIP", priceCents: 100, currency: "XYZ" }).success).toBe(false);
  });
});

describe("updateTierSchema", () => {
  it("allows changing only the name", () => {
    expect(updateTierSchema.safeParse({ name: "Gold" }).success).toBe(true);
  });

  it("rejects an empty update", () => {
    expect(updateTierSchema.safeParse({}).success).toBe(false);
  });
});
