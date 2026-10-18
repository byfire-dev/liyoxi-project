// W2-23；a01 2.20、3.77–3.83。运输状态与业务流程状态分开。
import { DateSchema, IdSchema, InstantSchema, PageQuerySchema } from "../../common/index.js";
import {
  AGGREGATE_TYPES,
  EVENTS,
  JOBS,
  SUBSCRIBERS,
  TIMERS,
  TIMER_SUBJECT_TYPES,
} from "../../registry/index.js";
import { z } from "../../zod.js";
import { AdminCursorQuerySchema, adminCursorPage, adminPage } from "./structures.js";

const TIMER_STATES = [
  "scheduled",
  "dispatched",
  "fired",
  "skipped",
  "cancelled",
  "failed",
] as const;
const DELIVERY_STATES = ["pending", "leased", "done", "retry", "dead"] as const;
const WEBHOOK_STATES = ["received", "processed", "ignored", "failed", "dead"] as const;
const PROVIDERS = ["wechatpay", "wechat", "wecom", "ci", "asr", "sms", "esign"] as const;
const registered = (values: readonly string[]) =>
  z
    .string()
    .min(1)
    .max(200)
    .refine((value) => values.includes(value), "未登记的值");
const csv = (values: readonly string[]) =>
  z
    .string()
    .min(1)
    .max(2000)
    .refine((value) => value.split(",").every((part) => values.includes(part)), "查询值未登记")
    .transform((value) => [...new Set(value.split(","))]);
const paired = (type: unknown, id: unknown) => Boolean(type) === Boolean(id);
export const TimerListQuerySchema = PageQuerySchema.extend({
  status: csv(TIMER_STATES).default(["failed"]),
  kind: csv([...TIMERS.map((row) => row.kind), ...JOBS.map((row) => row.kind)]).optional(),
  subjectType: registered(TIMER_SUBJECT_TYPES).optional(),
  subjectId: IdSchema.optional(),
  entityId: IdSchema.optional(),
  fireFrom: DateSchema.optional(),
  fireTo: DateSchema.optional(),
})
  .superRefine((value, ctx) => {
    if (!paired(value.subjectType, value.subjectId))
      ctx.addIssue({ code: "custom", path: ["subjectId"], message: "主体类型与id须同有同无" });
    if (value.fireFrom && value.fireTo && value.fireFrom > value.fireTo)
      ctx.addIssue({ code: "custom", path: ["fireTo"], message: "日期范围倒置" });
  })
  .openapi("TimerListQuery");
export type TimerListQuery = z.infer<typeof TimerListQuerySchema>;
export const OutboxDeliveryListQuerySchema = PageQuerySchema.extend({
  status: csv(DELIVERY_STATES).default(["dead"]),
  subscriber: registered(SUBSCRIBERS.map((row) => row.name)).optional(),
  eventType: registered(EVENTS.map((row) => row.name)).optional(),
  aggregateType: registered(AGGREGATE_TYPES).optional(),
  aggregateId: IdSchema.optional(),
  entityId: IdSchema.optional(),
})
  .superRefine((value, ctx) => {
    if (!paired(value.aggregateType, value.aggregateId))
      ctx.addIssue({ code: "custom", path: ["aggregateId"], message: "聚合类型与id须同有同无" });
  })
  .openapi("OutboxDeliveryListQuery");
export type OutboxDeliveryListQuery = z.infer<typeof OutboxDeliveryListQuerySchema>;
export const WebhookEventListQuerySchema = AdminCursorQuerySchema.extend({
  cursor: z.string().min(1).max(512).optional(),
  provider: csv(PROVIDERS).optional(),
  processState: csv(WEBHOOK_STATES).default(["failed", "dead"]),
  eventType: z.string().min(1).max(200).optional(),
  receivedFrom: DateSchema.optional(),
  receivedTo: DateSchema.optional(),
})
  .superRefine((value, ctx) => {
    if (value.receivedFrom && value.receivedTo && value.receivedFrom > value.receivedTo)
      ctx.addIssue({ code: "custom", path: ["receivedTo"], message: "日期范围倒置" });
  })
  .openapi("WebhookEventListQuery");
export type WebhookEventListQuery = z.infer<typeof WebhookEventListQuerySchema>;
const text = z
  .string()
  .trim()
  .refine((value) => Array.from(value).length <= 200, "至多200字");
export const FlowOpsNoteBodySchema = z
  .strictObject({ note: text.optional() })
  .openapi("FlowOpsNoteBody");
export const TimerCancelBodySchema = z
  .strictObject({ reason: text.refine((value) => Array.from(value).length >= 5, "至少5字") })
  .openapi("TimerCancelBody");
export const OutboxRetryBodySchema = z
  .strictObject({
    subscriber: registered(SUBSCRIBERS.map((row) => row.name)),
    note: text.optional(),
  })
  .openapi("OutboxRetryBody");
const json = z.record(z.string(), z.unknown()).nullable();
const at = InstantSchema.nullable();
export const TimerViewSchema = z
  .object({
    timerId: IdSchema,
    kind: z.string(),
    subject: z.object({ type: z.string(), id: IdSchema }).nullable(),
    entityId: IdSchema.nullable(),
    storeId: IdSchema.nullable(),
    fireAt: InstantSchema,
    retryAt: at,
    dedupeKey: z.string(),
    status: z.enum(TIMER_STATES),
    attempts: z.int().min(0),
    dispatchNo: z.int().min(0),
    leaseUntil: at,
    firedAt: at,
    lastError: z.string().nullable(),
    payload: json,
    result: json,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    actions: z.array(z.enum(["reschedule", "cancel"])),
  })
  .openapi("TimerView");
export type TimerView = z.infer<typeof TimerViewSchema>;
export const OutboxDeliveryViewSchema = z
  .object({
    outboxEventId: IdSchema,
    subscriber: z.string(),
    status: z.enum(DELIVERY_STATES),
    attempts: z.int().min(0),
    dispatchNo: z.int().min(0),
    nextAttemptAt: InstantSchema,
    leaseUntil: at,
    consumedAt: at,
    lastError: z.string().nullable(),
    event: z.object({
      eventType: z.string(),
      aggregateType: z.string().nullable(),
      aggregateId: IdSchema.nullable(),
      entityId: IdSchema.nullable(),
      storeId: IdSchema.nullable(),
      occurredAt: InstantSchema,
      actorType: z.string(),
      requestId: z.string().nullable(),
    }),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    actions: z.array(z.literal("retry")),
  })
  .openapi("OutboxDeliveryView");
export type OutboxDeliveryView = z.infer<typeof OutboxDeliveryViewSchema>;
export const WebhookEventViewSchema = z
  .object({
    webhookEventId: IdSchema,
    provider: z.enum(PROVIDERS),
    eventId: z.string(),
    eventType: z.string(),
    mode: z.enum(["inline", "inbox"]),
    processState: z.enum(WEBHOOK_STATES),
    attempts: z.int().min(0),
    receivedAt: InstantSchema,
    nextAttemptAt: at,
    processedAt: at,
    error: z.string().nullable(),
    summary: json,
    payloadPurgedAt: at,
    actions: z.array(z.literal("retry")),
  })
  .openapi("WebhookEventView");
export type WebhookEventView = z.infer<typeof WebhookEventViewSchema>;
export const TimerPageSchema = adminPage(TimerViewSchema).openapi("TimerPage");
export const OutboxDeliveryPageSchema =
  adminPage(OutboxDeliveryViewSchema).openapi("OutboxDeliveryPage");
export const WebhookEventPageSchema =
  adminCursorPage(WebhookEventViewSchema).openapi("WebhookEventPage");
