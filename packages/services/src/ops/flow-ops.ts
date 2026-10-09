// W2-23：技术运输查询/人工恢复，业务时限与业务状态不在此处可写。
import {
  FlowOpsNoteBodySchema,
  TimerCancelBodySchema,
  OutboxRetryBodySchema,
  z,
} from "@liyoxi/contract";
import type {
  TimerListQuery,
  OutboxDeliveryListQuery,
  WebhookEventListQuery,
  AuditAction,
  AuditTargetType,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { dayRange } from "@liyoxi/shared/time";
import { hasPermission, satisfiesLevel, assertPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { record } from "../audit/index.js";
import type { AuditRequestMeta } from "../audit/index.js";
import { AppError, isUuid } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx, TxRunner, TxRunOptions } from "../kernel/index.js";
import { retryDeadDelivery } from "../events/index.js";
import { recoverFailedTimer } from "../timers/index.js";
import { retryDeadWebhook } from "../security/index.js";
import { timerView, deliveryView, webhookView } from "./flow-ops.projection.js";
export interface FlowOpsActor {
  readonly staff: StaffContext;
  readonly identity: IdentityContext;
  readonly meta: AuditRequestMeta;
}
export interface FlowOpsDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
}
export function assertFlowOpsRead(ctx: StaffContext) {
  if (!satisfiesLevel(ctx.moduleLevels.system, "view") && !hasPermission(ctx, "flow.ops.view"))
    throw new AppError("PERMISSION_DENIED");
}
export function assertFlowOpsWrite(ctx: FlowOpsActor, clock: Clock) {
  assertPermission(ctx.staff, "flow.ops.manage", clock.now());
  if (ctx.identity.actor.type !== "staff" || ctx.identity.actor.id !== ctx.staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
}
export async function recordFlowOps(
  tx: Tx,
  ctx: FlowOpsActor,
  action: AuditAction,
  target: { type: AuditTargetType; id: string },
  before: object,
  after: object,
  note?: string,
  scope?: { entityId: string | null; storeId: string | null },
) {
  const entry = {
    stream: "ops" as const,
    category: "system_ops" as const,
    action,
    summary: action,
    target,
    before,
    after,
    fields: Object.keys(after),
    ...(note ? { reason: { code: "other", text: note } } : {}),
  };
  if (scope?.entityId)
    await record(tx, ctx.identity.actor, ctx.meta, {
      ...entry,
      entityId: scope.entityId,
      storeId: scope.storeId,
    });
  else await record(tx, ctx.identity.actor, ctx.meta, entry);
}
function checked<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("VALIDATION_FAILED");
  return result.data;
}
function range(from?: string, to?: string) {
  return {
    ...(from ? { gte: dayRange(from).start } : {}),
    ...(to ? { lt: dayRange(to).end } : {}),
  };
}
function decodeCursor(raw: string | undefined) {
  if (!raw) return null;
  try {
    if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const parsed = z
      .strictObject({ at: z.iso.datetime({ precision: 3 }), id: z.string().uuid() })
      .parse(value);
    if (!isUuid(parsed.id)) throw new Error();
    return { at: new Date(parsed.at), id: parsed.id };
  } catch {
    throw new AppError("VALIDATION_FAILED");
  }
}
export function createFlowOps(deps: FlowOpsDeps) {
  const manage = (ctx: StaffContext) => hasPermission(ctx, "flow.ops.manage");
  return {
    listTimers(ctx: StaffContext, query: TimerListQuery) {
      assertFlowOpsRead(ctx);
      return deps.tx.run(async (tx) => {
        const where: Prisma.TimerWhereInput = {
          status: { in: query.status },
          ...(query.kind ? { kind: { in: query.kind } } : {}),
          ...(query.subjectType
            ? { subjectType: query.subjectType, subjectId: query.subjectId }
            : {}),
          ...(query.entityId ? { entityId: query.entityId } : {}),
          ...(query.fireFrom || query.fireTo
            ? { fireAt: range(query.fireFrom, query.fireTo) }
            : {}),
        };
        const rows = await tx.timer.findMany({
          where,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ fireAt: "asc" }, { id: "asc" }],
        });
        return {
          items: rows.map((row) => timerView(row, manage(ctx))),
          page: query.page,
          pageSize: query.pageSize,
          total: await tx.timer.count({ where }),
        };
      });
    },
    listDeliveries(ctx: StaffContext, query: OutboxDeliveryListQuery) {
      assertFlowOpsRead(ctx);
      return deps.tx.run(async (tx) => {
        const where: Prisma.OutboxDeliveryWhereInput = {
          status: { in: query.status },
          ...(query.subscriber ? { subscriber: query.subscriber } : {}),
          outboxEvent: {
            ...(query.eventType ? { eventType: query.eventType } : {}),
            ...(query.aggregateType
              ? { aggregateType: query.aggregateType, aggregateId: query.aggregateId }
              : {}),
            ...(query.entityId ? { entityId: query.entityId } : {}),
          },
        };
        const rows = await tx.outboxDelivery.findMany({
          where,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ updatedAt: "desc" }, { outboxEventId: "desc" }, { subscriber: "asc" }],
          include: { outboxEvent: true },
        });
        return {
          items: rows.map((row) => deliveryView(row, manage(ctx))),
          page: query.page,
          pageSize: query.pageSize,
          total: await tx.outboxDelivery.count({ where }),
        };
      });
    },
    listWebhooks(ctx: StaffContext, query: WebhookEventListQuery) {
      assertFlowOpsRead(ctx);
      const cursor = decodeCursor(query.cursor);
      return deps.tx.run(async (tx) => {
        const base: Prisma.WebhookEventWhereInput = {
          processState: { in: query.processState },
          ...(query.provider ? { provider: { in: query.provider } } : {}),
          ...(query.eventType ? { eventType: query.eventType } : {}),
          ...(query.receivedFrom || query.receivedTo
            ? { receivedAt: range(query.receivedFrom, query.receivedTo) }
            : {}),
        };
        const where = {
          ...base,
          ...(cursor
            ? {
                OR: [
                  { receivedAt: { lt: cursor.at } },
                  { receivedAt: cursor.at, id: { lt: cursor.id } },
                ],
              }
            : {}),
        };
        const rows = await tx.webhookEvent.findMany({
          where,
          take: query.limit + 1,
          orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        });
        const items = rows.slice(0, query.limit),
          last = items.at(-1),
          hasMore = rows.length > query.limit;
        const count = await tx.webhookEvent.findMany({
          where: base,
          select: { id: true },
          take: 10000,
        });
        return {
          items: items.map((row) => webhookView(row, manage(ctx))),
          hasMore,
          totalApprox: count.length,
          nextCursor:
            hasMore && last
              ? Buffer.from(
                  JSON.stringify({ at: last.receivedAt.toISOString(), id: last.id }),
                ).toString("base64url")
              : null,
        };
      });
    },
    rescheduleTimer(ctx: FlowOpsActor, id: string, input: unknown, options?: TxRunOptions) {
      assertFlowOpsWrite(ctx, deps.clock);
      const body = checked(FlowOpsNoteBodySchema, input);
      return deps.tx.run(async (tx) => {
        const { before, after } = await recoverFailedTimer(tx, id, "reschedule", deps.clock.now());
        await recordFlowOps(
          tx,
          ctx,
          "flow.timer.reschedule",
          { type: "timer", id },
          { status: before.status, attempts: before.attempts, retryAt: before.retryAt },
          { status: after.status, attempts: after.attempts, retryAt: after.retryAt },
          body.note,
          after,
        );
        return timerView(after, true);
      }, options);
    },
    cancelTimer(ctx: FlowOpsActor, id: string, input: unknown, options?: TxRunOptions) {
      assertFlowOpsWrite(ctx, deps.clock);
      const body = checked(TimerCancelBodySchema, input);
      return deps.tx.run(async (tx) => {
        const { before, after } = await recoverFailedTimer(tx, id, "cancel", deps.clock.now());
        await recordFlowOps(
          tx,
          ctx,
          "flow.timer.cancel",
          { type: "timer", id },
          { status: before.status },
          { status: after.status },
          body.reason,
          after,
        );
        return timerView(after, true);
      }, options);
    },
    retryDelivery(ctx: FlowOpsActor, id: string, input: unknown, options?: TxRunOptions) {
      assertFlowOpsWrite(ctx, deps.clock);
      const body = checked(OutboxRetryBodySchema, input);
      return deps.tx.run(async (tx) => {
        const { before, after } = await retryDeadDelivery(
          tx,
          id,
          body.subscriber,
          deps.clock.now(),
        );
        const e = await tx.outboxEvent.findUniqueOrThrow({ where: { id } });
        await recordFlowOps(
          tx,
          ctx,
          "flow.outbox.retry",
          { type: "outbox_delivery", id: id + ":" + body.subscriber },
          { status: before.status, attempts: before.attempts, nextAttemptAt: before.nextAttemptAt },
          { status: after.status, attempts: after.attempts, nextAttemptAt: after.nextAttemptAt },
          body.note,
          e,
        );
        return deliveryView({ ...after, outboxEvent: e }, true);
      }, options);
    },
    retryWebhook(ctx: FlowOpsActor, id: string, input: unknown, options?: TxRunOptions) {
      assertFlowOpsWrite(ctx, deps.clock);
      const body = checked(FlowOpsNoteBodySchema, input);
      return deps.tx.run(async (tx) => {
        const { before, after } = await retryDeadWebhook(tx, id, deps.clock.now());
        await recordFlowOps(
          tx,
          ctx,
          "ops.webhook.retry",
          { type: "webhook_event", id },
          {
            processState: before.processState,
            attempts: before.attempts,
            nextAttemptAt: before.nextAttemptAt,
          },
          {
            processState: after.processState,
            attempts: after.attempts,
            nextAttemptAt: after.nextAttemptAt,
          },
          body.note,
        );
        return webhookView(after, true);
      }, options);
    },
  };
}
export type FlowOps = ReturnType<typeof createFlowOps>;
