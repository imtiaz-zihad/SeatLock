import { z } from "zod";

// Generates rows x seatsPerRow seats in one section.
// Example: rows ["A","B","C"], seatsPerRow 10  ->  A1..A10, B1..B10, C1..C10
export const bulkSeatsSchema = z
  .object({
    tierId: z.uuid(),
    section: z.string().trim().min(1).max(20),
    rows: z.array(z.string().trim().min(1).max(10)).min(1).max(50),
    seatsPerRow: z.number().int().min(1).max(100),
    startNumber: z.number().int().min(1).max(1000).default(1),
  })
  .refine((d) => new Set(d.rows).size === d.rows.length, {
    message: "rows must be unique",
    path: ["rows"],
  })
  .refine((d) => d.rows.length * d.seatsPerRow <= 2000, {
    message: "At most 2000 seats per request",
    path: ["seatsPerRow"],
  });

export const listSeatsQuerySchema = z.object({
  status: z.enum(["AVAILABLE", "HELD", "SOLD"]).optional(),
  section: z.string().trim().min(1).max(20).optional(),
  tierId: z.uuid().optional(),
});

export type BulkSeatsInput = z.infer<typeof bulkSeatsSchema>;
export type ListSeatsQuery = z.infer<typeof listSeatsQuerySchema>;
