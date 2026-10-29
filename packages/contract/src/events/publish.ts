import { z } from "../zod.js";
import { DateSchema, IdSchema } from "../common/index.js";
import {
  CHANNEL_PLATFORM,
  LAUNCH_TASK_VOID_REASON,
  TAKEDOWN_TASK_BASIS,
  TAKEDOWN_TASK_TRIGGER_KIND,
} from "../enums/index.js";
const transition = {
  fromState: z.union([z.string(), z.null()]),
  toState: z.string(),
  transition: z.string(),
};
const account = {
  v: z.literal(1),
  channelAccountId: IdSchema,
  entityId: IdSchema,
  storeId: IdSchema,
  ...transition,
};
const launch = { v: z.literal(1), launchTaskId: IdSchema, orderItemId: IdSchema, ...transition };
export const payloads = {
  "account.submitted": z.strictObject({
    ...account,
    platform: z.enum(CHANNEL_PLATFORM.values),
    approvalRequestId: IdSchema,
  }),
  "account.verified": z.strictObject(account),
  "account.abnormal": z.strictObject({
    ...account,
    abnormalSource: z.enum(["verify", "manual"]),
    reasonCode: z.string(),
  }),
  "launch.created": z.strictObject({ ...launch, channelAccountId: IdSchema }),
  "launch.submitted": z.strictObject({
    ...launch,
    deliveryTicketId: IdSchema,
    roundNo: z.int().positive(),
    approvalRequestId: IdSchema,
  }),
  "launch.verified": z.strictObject({
    ...launch,
    verifiedEpisodeCount: z.int().positive(),
    isLive: z.boolean(),
  }),
  "launch.returned": z.strictObject({ ...launch, reasonCodes: z.array(z.string()) }),
  "launch.voided": z.strictObject({
    ...launch,
    voidReason: z.enum(LAUNCH_TASK_VOID_REASON.values),
    fromState: z.enum(["pending", "need_fix", "verifying", "passed"]),
    toState: z.literal("void"),
    transition: z.literal("launch.void"),
  }),
  "launch.settled": z.strictObject({
    ...launch,
    fromState: z.enum(["verifying", "need_fix"]),
    toState: z.literal("passed"),
    transition: z.literal("launch.settle"),
  }),
  "patrol.voided": z.strictObject({
    v: z.literal(1),
    patrolTaskId: IdSchema,
    fromState: z.enum(["pending", "abnormal"]),
    toState: z.literal("void"),
    transition: z.literal("patrol.void"),
  }),
  "takedown.created": z.strictObject({
    v: z.literal(1),
    takedownTaskId: IdSchema,
    orderItemId: IdSchema,
    channelAccountId: IdSchema,
    dueDate: DateSchema,
    basis: z.enum(TAKEDOWN_TASK_BASIS.values),
    triggerKind: z.enum(TAKEDOWN_TASK_TRIGGER_KIND.values),
    node: z.enum(["T-30", "created"]),
    fromState: z.null(),
    toState: z.literal("pending_merchant"),
    transition: z.literal("takedown.create"),
  }),
};
