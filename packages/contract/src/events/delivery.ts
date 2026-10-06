import { z } from "../zod.js";
import { IdSchema } from "../common/index.js";
const transition = {
  fromState: z.union([z.string(), z.null()]),
  toState: z.string(),
  transition: z.string(),
};
const ticket = {
  v: z.literal(1),
  deliveryTicketId: IdSchema,
  dramaOrderId: IdSchema,
  ...transition,
};
const plan = {
  v: z.literal(1),
  deliveryPlanId: IdSchema,
  dramaOrderId: IdSchema,
  versionNo: z.int().positive(),
  ...transition,
};
export const payloads = {
  "ticket.created": z.strictObject({
    ...ticket,
    orderItemId: IdSchema,
    deliveryManagerId: z.union([IdSchema, z.null()]),
  }),
  "ticket.assigned": z.strictObject({ ...ticket, deliveryManagerId: IdSchema }),
  "ticket.step_changed": z.strictObject({
    ...ticket,
    orderItemId: IdSchema,
    isForced: z.boolean(),
  }),
  "plan.pushed": z.strictObject(plan),
  "plan.change_requested": z.strictObject(plan),
  "plan.confirmed": z.strictObject(plan),
};
