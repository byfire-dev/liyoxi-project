// W6-03：x01 §3.11，事件身份沿既有 publish 登记，不新增事件名。
import { z } from "../zod.js";
import { IdSchema } from "../common/index.js";

const patrol = { v: z.literal(1), patrolTaskId: IdSchema };
export const payloads = {
  "account.unbound": z.strictObject({
    v: z.literal(1),
    channelAccountId: IdSchema,
    entityId: IdSchema,
    storeId: IdSchema,
    fromState: z.enum(["pending_verify", "available", "abnormal"]),
    toState: z.literal("unbound"),
    transition: z.literal("account.unbind"),
  }),
  "patrol.created": z.strictObject({
    ...patrol,
    launchTaskId: IdSchema,
    orderItemId: IdSchema,
    fromState: z.null(),
    toState: z.literal("pending"),
    transition: z.literal("patrol.create"),
  }),
  "patrol.passed": z.strictObject({
    ...patrol,
    launchTaskId: IdSchema,
    fromState: z.literal("pending"),
    toState: z.literal("normal"),
    transition: z.literal("patrol.ok"),
  }),
  "patrol.abnormal": z.strictObject({
    ...patrol,
    launchTaskId: IdSchema,
    orderItemId: IdSchema,
    abnormalKindCode: z.string().min(1),
    fromState: z.literal("pending"),
    toState: z.literal("abnormal"),
    transition: z.literal("patrol.abnormal"),
  }),
  "patrol.reminded": z.strictObject({
    ...patrol,
    remindCount: z.int().positive(),
    fromState: z.literal("abnormal"),
    toState: z.literal("abnormal"),
    transition: z.literal("patrol.remind"),
  }),
  "patrol.recovered": z.strictObject({
    ...patrol,
    launchTaskId: IdSchema,
    fromState: z.literal("abnormal"),
    toState: z.literal("recovered"),
    transition: z.literal("patrol.recover"),
  }),
};
