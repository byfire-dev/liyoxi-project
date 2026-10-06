import { z } from "../zod.js";
import { IdSchema, DateSchema } from "../common/index.js";
const transitionKeys = {
  fromState: z.string().nullable(),
  toState: z.string(),
  transition: z.string(),
};
export const payloads = {
  "order.started": z.object({
    v: z.literal(1),
    dramaOrderId: IdSchema,
    entityId: IdSchema,
    storeId: IdSchema,
    orderItemIds: z.array(IdSchema).min(1),
    deliveryTicketIds: z.array(IdSchema).min(1),
    ...transitionKeys,
  }),
  "order.status_changed": z.object({ v: z.literal(1), dramaOrderId: IdSchema, ...transitionKeys }),
  "order.item.went_live": z.object({
    v: z.literal(1),
    orderItemId: IdSchema,
    dramaOrderId: IdSchema,
    usageStartDate: DateSchema,
    ...transitionKeys,
  }),
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
