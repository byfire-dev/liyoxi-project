import { z } from "../zod.js";
import { IdSchema } from "../common/scalars.js";
const common = {
  v: z.literal(1),
  notificationDeliveryId: IdSchema,
  bizType: z.literal("invoice_doc"),
  bizId: IdSchema,
  attemptNo: z.int().nonnegative(),
};
/** Compatible name: Provider accepted this delivery; does not prove mailbox arrival. */
export const payloads = {
  "notify.mail_delivered": z.strictObject({ ...common, status: z.literal("sent") }),
  "notify.mail_failed": z.strictObject({
    ...common,
    status: z.enum(["failed", "skipped", "cancelled"]),
    reason: z.enum([
      "unconfigured",
      "guard_invalid",
      "policy_suppressed",
      "collapsed",
      "rate_limited",
      "no_target",
      "claim_exhausted",
      "retry_exhausted",
      "provider_rejected",
      "unknown_outcome",
      "user_refused",
    ]),
  }),
} as const;
