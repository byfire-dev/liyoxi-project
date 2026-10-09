import { IdSchema } from "../common/index.js";
import { z } from "../zod.js";
export const dramaCreatedPayload = z.strictObject({
  v: z.literal(1),
  dramaId: IdSchema,
  fromState: z.null(),
  toState: z.literal("draft"),
  transition: z.literal("drama.create"),
});
export const dramaListedPayload = z.strictObject({
  v: z.literal(1),
  dramaId: IdSchema,
  isRelist: z.literal(false),
  fromState: z.literal("draft"),
  toState: z.literal("listed"),
  transition: z.literal("drama.list"),
});
export const payloads = {
  "drama.masters_changed": z.strictObject({
    v: z.literal(1),
    dramaId: IdSchema,
    uploadBatchId: IdSchema,
    episodeNos: z.array(z.int().positive()),
    isContentChanged: z.boolean(),
  }),
  "drama.created": dramaCreatedPayload,
  "drama.listed": dramaListedPayload,
} as const;
