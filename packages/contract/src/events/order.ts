import { z } from "../zod.js";
import { IdSchema } from "../common/index.js";
export const payloads = {
  "order.submitted": z.object({
    v: z.literal(1),
    dramaOrderId: IdSchema,
    entityId: IdSchema,
    storeId: IdSchema,
    orderItemIds: z.array(IdSchema).min(1),
    totalPoints: z.int().positive(),
    placedByUserId: IdSchema,
    fromState: z.string().nullable(),
    toState: z.string(),
    transition: z.string(),
  }),
} as const;
