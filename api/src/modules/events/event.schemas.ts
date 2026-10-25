import { z } from "zod";

// Fields shared by create and update.
const eventFields = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(5000).optional(),
  venue: z.string().trim().min(2).max(200),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
});

export const createEventSchema = eventFields
  .refine((d) => d.endsAt > d.startsAt, {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  })
  .refine((d) => d.startsAt > new Date(), {
    message: "startsAt must be in the future",
    path: ["startsAt"],
  });

// Every field optional, but at least one must be sent.
// (The startsAt/endsAt order is checked in the service, against the stored values.)
export const updateEventSchema = eventFields
  .partial()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Send at least one field to update",
  });

export const eventIdParamSchema = z.object({
  id: z.uuid(),
});

export const listEventsQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.uuid().optional(),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
