import { z } from "zod";

const tierFields = z.object({
  name: z.string().trim().min(1).max(50),
  priceCents: z.number().int().min(0).max(10_000_000), // money is always stored in cents
  currency: z.enum(["USD", "BDT", "EUR", "GBP"]).default("USD"),
});

export const createTierSchema = tierFields;

// Currency cannot change after creation.
export const updateTierSchema = tierFields
  .omit({ currency: true })
  .partial()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Send at least one field to update",
  });

export const tierParamSchema = z.object({
  id: z.uuid(),
  tierId: z.uuid(),
});

export type CreateTierInput = z.infer<typeof createTierSchema>;
export type UpdateTierInput = z.infer<typeof updateTierSchema>;
