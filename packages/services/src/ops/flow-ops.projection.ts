// 只投影正式协议认识的结构；未知对象返回 null，不递归删敏感键后放行任意剩余文本。
import {
  z,
  TimerViewSchema,
  OutboxDeliveryViewSchema,
  WebhookEventViewSchema,
} from "@liyoxi/contract";
import { PARAM_KEYS_BY_GROUP } from "@liyoxi/contract/config/params";
import type { Timer, OutboxDelivery, OutboxEvent, WebhookEvent } from "@liyoxi/db";
const policies: readonly string[] = PARAM_KEYS_BY_GROUP.sla.map((key) => key.slice(4));
const sla = z.strictObject({
  policy: z.string().refine((value) => policies.includes(value)),
  amount: z.number().finite().nonnegative(),
  unit: z.enum(["work_minutes", "work_days", "natural_hours", "natural_days", "same_day_cutoff"]),
  calendarVersion: z.int().nonnegative(),
  computedAt: z.iso.datetime({ offset: true }),
});
const paymentSummary = z.strictObject({
  serial: z.string().regex(/^[A-Fa-f0-9]{1,64}$/),
  state: z.enum([
    "SUCCESS",
    "REFUND",
    "NOTPAY",
    "CLOSED",
    "REVOKED",
    "USERPAYING",
    "PAYERROR",
    "PROCESSING",
    "ABNORMAL",
  ]),
  amountFen: z.int().nonnegative(),
  outTradeNo: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .optional(),
  outRefundNo: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  transactionId: z
    .string()
    .regex(/^\d{1,64}$/)
    .optional(),
  refundId: z
    .string()
    .regex(/^\d{1,64}$/)
    .optional(),
  successAt: z.iso.datetime({ offset: true }).optional(),
});
export function safeFailure(value: string | null): string | null {
  if (value === null) return null;
  // 外部错误可能包含任意内容；只保留确定的错误类别，不把拼接文本作为去敏证据。
  const match = /^(Error|TypeError|RangeError|TimeoutError|AppError|ProviderError):/.exec(value);
  return `${match?.[1] ?? "处理失败"}（原始详情已隐去）`;
}
const iso = (value: Date | null) => value?.toISOString() ?? null;
export function timerView(row: Timer, manage: boolean) {
  const payload = row.kind === "sla.breach" ? sla.safeParse(row.payload) : null;
  return TimerViewSchema.parse({
    timerId: row.id,
    kind: row.kind,
    subject: row.subjectType && row.subjectId ? { type: row.subjectType, id: row.subjectId } : null,
    entityId: row.entityId,
    storeId: row.storeId,
    fireAt: iso(row.fireAt),
    retryAt: iso(row.retryAt),
    dedupeKey: row.dedupeKey,
    status: row.status,
    attempts: row.attempts,
    dispatchNo: row.dispatchNo,
    leaseUntil: iso(row.leaseUntil),
    firedAt: iso(row.firedAt),
    lastError: safeFailure(row.lastError),
    payload: payload?.success ? payload.data : null,
    // result 允许任意处理器摘要，尚无正式安全结构的运行结果不能出现在运营响应。
    result: null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    actions: manage && row.status === "failed" ? ["reschedule", "cancel"] : [],
  });
}
export function deliveryView(row: OutboxDelivery & { outboxEvent: OutboxEvent }, manage: boolean) {
  const e = row.outboxEvent;
  return OutboxDeliveryViewSchema.parse({
    outboxEventId: row.outboxEventId,
    subscriber: row.subscriber,
    status: row.status,
    attempts: row.attempts,
    dispatchNo: row.dispatchNo,
    nextAttemptAt: iso(row.nextAttemptAt),
    leaseUntil: iso(row.leaseUntil),
    consumedAt: iso(row.consumedAt),
    lastError: safeFailure(row.lastError),
    event: {
      eventType: e.eventType,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      entityId: e.entityId,
      storeId: e.storeId,
      occurredAt: iso(e.occurredAt),
      actorType: e.actorType,
      requestId: e.requestId,
    },
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    actions: manage && row.status === "dead" ? ["retry"] : [],
  });
}
export function webhookView(row: WebhookEvent, manage: boolean) {
  const payload = row.payload;
  const raw =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.hasOwn(payload, "summary")
      ? payload["summary"]
      : null;
  const summary = row.provider === "wechatpay" ? paymentSummary.safeParse(raw) : null;
  return WebhookEventViewSchema.parse({
    webhookEventId: row.id,
    provider: row.provider,
    eventId: row.eventId,
    eventType: row.eventType,
    mode: row.mode,
    processState: row.processState,
    attempts: row.attempts,
    receivedAt: iso(row.receivedAt),
    nextAttemptAt: iso(row.nextAttemptAt),
    processedAt: iso(row.processedAt),
    error: safeFailure(row.error),
    summary: summary?.success ? summary.data : null,
    payloadPurgedAt: iso(row.payloadPurgedAt),
    actions: manage && row.processState === "dead" ? ["retry"] : [],
  });
}
