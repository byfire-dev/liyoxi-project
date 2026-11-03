import { z } from "../zod.js";
import { IdSchema } from "../common/index.js";

/** Existing W6-02 event names gain the exact payloads emitted by their real writers. */
export const payloads = {
  "order.item.live_revoked": z.strictObject({
    v: z.literal(1),
    orderItemId: IdSchema,
    dramaOrderId: IdSchema,
    fromState: z.literal("live"),
    toState: z.literal("to_launch"),
    transition: z.literal("launch.verify_revoked"),
  }),
  "publish_list.updated": z.strictObject({
    v: z.literal(1),
    publishListId: IdSchema,
    deliveryTicketId: IdSchema,
    isAfterPush: z.boolean(),
  }),
  "launch.verify_revoked": z.strictObject({
    v: z.literal(1),
    launchTaskId: IdSchema,
    orderItemId: IdSchema,
    isLive: z.boolean(),
    fromState: z.literal("passed"),
    toState: z.literal("verifying"),
    transition: z.literal("launch.verify_revoke"),
  }),
};
