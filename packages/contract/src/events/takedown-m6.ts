// W6-04：x01 第3.10节既有事件的精确业务载荷；抽签参数仅在状态历史中冻结。
import { z } from "../zod.js";
import { DateSchema, IdSchema } from "../common/index.js";
import { TAKEDOWN_TASK_MERCHANT_METHOD, TAKEDOWN_TASK_CHECK_METHOD } from "../enums/index.js";
const base = { v: z.literal(1), takedownTaskId: IdSchema, orderItemId: IdSchema };
export const payloads = {
  "takedown.merchant_confirmed": z.strictObject({
    ...base,
    merchantMethod: z.enum(TAKEDOWN_TASK_MERCHANT_METHOD.values),
    fromState: z.literal("pending_merchant"),
    toState: z.literal("merchant_confirmed"),
    transition: z.literal("takedown.merchant_confirm"),
  }),
  "takedown.checked": z
    .strictObject({
      ...base,
      checkMethod: z.enum(TAKEDOWN_TASK_CHECK_METHOD.values),
      fromState: z.enum(["pending_merchant", "merchant_confirmed"]),
      toState: z.literal("checked"),
      transition: z.enum(["takedown.check_pass", "takedown.sample_release"]),
    })
    .refine(
      (p) =>
        p.transition === "takedown.sample_release"
          ? p.checkMethod === "sampled_out" && p.fromState === "merchant_confirmed"
          : p.checkMethod === "evidence",
      "核查方式与迁移须匹配",
    ),
  "takedown.found_online": z.strictObject({
    ...base,
    stillOnlineCount: z.int().positive(),
    fromState: z.literal("merchant_confirmed"),
    toState: z.literal("pending_merchant"),
    transition: z.literal("takedown.still_online"),
  }),
  "takedown.escalated": z.strictObject({
    ...base,
    dueDate: DateSchema,
    fromState: z.literal("pending_merchant"),
    toState: z.literal("pending_merchant"),
    transition: z.literal("takedown.escalate"),
  }),
  "takedown.basis_reopened": z.strictObject({
    ...base,
    fromState: z.literal("merchant_confirmed"),
    toState: z.literal("pending_merchant"),
    transition: z.literal("takedown.basis_reopen"),
  }),
  "takedown.breach_notified": z.strictObject({
    v: z.literal(1),
    takedownTaskId: IdSchema,
    breachNoticeCount: z.int().positive(),
    fromState: z.literal("pending_merchant"),
    toState: z.literal("pending_merchant"),
    transition: z.literal("takedown.breach_notice"),
  }),
};
