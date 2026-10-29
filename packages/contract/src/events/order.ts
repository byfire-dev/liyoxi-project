import { z } from "../zod.js";
import { IdSchema, DateSchema, InstantSchema } from "../common/index.js";
const transitionKeys = {
  fromState: z.string().nullable(),
  toState: z.string(),
  transition: z.string(),
};
const cancel = { v: z.literal(1), cancelRequestId: IdSchema };
const cancelled = {
  ...cancel,
  fromState: z.literal("pending_approval"),
  toState: z.literal("not_executed"),
};
export const payloads = {
  "order.item.cancelled": z.strictObject({
    v: z.literal(1),
    orderItemId: IdSchema,
    dramaOrderId: IdSchema,
    cancelRequestId: IdSchema,
    returnedPoints: z.int().nonnegative(),
    convertedPoints: z.int().nonnegative(),
    forfeitedPoints: z.int().nonnegative(),
    ...transitionKeys,
  }),
  "order.item.refunded": z.strictObject({
    v: z.literal(1),
    orderItemId: IdSchema,
    dramaOrderId: IdSchema,
    cancelRequestId: IdSchema.optional(),
    returnedPoints: z.int().nonnegative(),
    convertedPoints: z.int().nonnegative(),
    forfeitedPoints: z.int().nonnegative(),
    ...transitionKeys,
  }),
  "order.item.terminated": z.strictObject({
    v: z.literal(1),
    orderItemId: IdSchema,
    dramaOrderId: IdSchema,
    cancelRequestId: IdSchema,
    ...transitionKeys,
  }),
  "order.rejected_stale": z.strictObject({
    v: z.literal(1),
    dramaOrderId: IdSchema,
    storeId: IdSchema,
    rejectedAt: InstantSchema,
  }),
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
  "cancel.submitted": z
    .strictObject({
      ...cancel,
      approvalRequestId: IdSchema,
      kind: z.enum(["order_cancel", "ad_cancel", "qualification_cancel"]),
      subjectType: z.enum(["drama_order", "ad", "store"]),
      subjectId: IdSchema,
      totalRefundPoints: z.int().nonnegative(),
      fromState: z.null(),
      toState: z.literal("pending_approval"),
      transition: z.literal("cancel.submit"),
    })
    .refine(
      (v) =>
        ({ order_cancel: "drama_order", ad_cancel: "ad", qualification_cancel: "store" })[
          v.kind
        ] === v.subjectType,
    ),
  "cancel.approved": z.strictObject({
    ...cancel,
    execDueAt: InstantSchema,
    fromState: z.literal("pending_approval"),
    toState: z.literal("pending_execution"),
    transition: z.literal("approval.approved"),
  }),
  "cancel.rejected": z.strictObject({ ...cancelled, transition: z.literal("approval.rejected") }),
  "cancel.withdrawn": z.strictObject({ ...cancelled, transition: z.literal("approval.withdrawn") }),
  "cancel.voided": z.strictObject({
    ...cancel,
    fromState: z.literal("pending_execution"),
    toState: z.literal("not_executed"),
    transition: z.literal("cancel.void"),
  }),
  "cancel.executed": z.discriminatedUnion("isAutoExecuted", [
    z.strictObject({
      ...cancel,
      isAutoExecuted: z.literal(false),
      fromState: z.literal("pending_execution"),
      toState: z.literal("done"),
      transition: z.literal("cancel.execute"),
    }),
    z.strictObject({
      ...cancel,
      isAutoExecuted: z.literal(true),
      fromState: z.literal("pending_approval"),
      toState: z.literal("done"),
      transition: z.literal("cancel.auto_execute"),
    }),
  ]),
} as const;
