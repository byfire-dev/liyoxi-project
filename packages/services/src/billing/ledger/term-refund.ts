// W4-10：现金退款的权益一侧。只在调用方事务内工作，账户420最后锁；不向渠道外呼。
import type { Prisma, SubscriptionTerm } from "@liyoxi/db";
import { z } from "zod";
import { boundary, grantDates, termDates } from "@liyoxi/shared/period";
import { addDays, endOfDay, startOfDay } from "@liyoxi/shared/time";
import { actorColumns, AppError, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import { paramsAt } from "../pricing/index.js";
import { captureSubscriptionDailySnapshot } from "../reporting/snapshot.js";
import type { PlanRefundPreview, PlanRefundRule, RevokeTermResult } from "../subscription/types.js";
import { createLedger } from "./index.js";
import { grantDue, refreshNextDue } from "./advance.js";
import { acquireAccount, fromDateColumn, toDateColumn } from "./context.js";
import type { LedgerClock } from "./context.js";
import { findOperation, isRefundPending, loadAccount, writeOperation } from "./operation.js";
import type { BucketMove } from "./operation.js";
import { selfCheck } from "./self-check.js";
import type { Db, LedgerDeps } from "./types.js";

const resultSchema = z.object({
  revokedPoints: z.int().nonnegative(),
  cancelledSchedules: z.int().nonnegative(),
  billingOrderIds: z.array(z.uuid()),
});
const refuse = (reasons: string[]) => {
  if (reasons.length) throw new AppError("PLAN_REFUND_NOT_ELIGIBLE", { details: { reasons } });
};

export function createTermRefund(deps: LedgerDeps) {
  const ledger = createLedger(deps);
  async function previewPlanRefund(db: Db, termId: string): Promise<PlanRefundPreview> {
    const term = await db.subscriptionTerm.findUnique({ where: { id: termId } });
    if (!term) throw new AppError("NOT_FOUND");
    const [lots, holds, upgrades, pending, account, next, params] = await Promise.all([
      db.pointLot.findMany({ where: { subscriptionTermId: termId } }),
      db.pointHold.count({
        where: {
          subscriptionTermId: termId,
          status: { in: ["held", "captured", "refunded_partial"] },
        },
      }),
      db.subscriptionEvent.findMany({
        where: { subscriptionTermId: termId, type: "upgraded" },
        orderBy: { seq: "asc" },
        select: { billingOrderId: true },
      }),
      db.grantSchedule.count({ where: { subscriptionTermId: termId, status: "pending" } }),
      db.billingAccount.findUniqueOrThrow({ where: { entityId: term.entityId } }),
      db.subscriptionTerm.count({
        where: { entityId: term.entityId, status: "scheduled", id: { not: termId } },
      }),
      paramsAt(db, deps.clock.now()),
    ]);
    const touched = lots.filter(
      (l) => l.heldQty + l.consumedQty + l.convertedOutQty + l.adjustedOutQty > 0,
    ).length;
    const deadline =
      term.status === "scheduled"
        ? null
        : new Date(term.startsAt.getTime() + params.planRefundWindowHours * 3_600_000);
    const current = account.currentSubscriptionTermId === termId;
    return {
      termId,
      entityId: term.entityId,
      termStatus: term.status,
      termStartsAt: term.startsAt.toISOString(),
      termEndsAt: term.endsAt.toISOString(),
      windowDeadline: deadline?.toISOString() ?? null,
      withinWindow: deadline === null || deps.clock.now() <= deadline,
      unused: touched === 0 && holds === 0,
      upgraded: upgrades.length > 0,
      refundableFen: term.priceTotalFen,
      billingOrderIds: [
        ...new Set([
          term.sourceBillingOrderId,
          ...upgrades.flatMap((u) => (u.billingOrderId ? [u.billingOrderId] : [])),
        ]),
      ],
      addonAvailable: account.addonAvailableQty,
      usage: { heldOrUsedHolds: holds, lotsTouched: touched },
      sideEffects: {
        revokePoints: lots.reduce((n, l) => n + l.availableQty + l.expiredQty, 0),
        cancelSchedules: pending,
        addonWillSuspend: current && next === 0 ? account.addonAvailableQty : 0,
        nextTermWillStartNow: current && next > 0,
      },
    };
  }
  async function enter(tx: Tx, termId: string) {
    const before = await tx.subscriptionTerm.findUniqueOrThrow({ where: { id: termId } });
    const clock = await ledger.lockAccount(tx, before.entityId);
    const term = await tx.subscriptionTerm.findUniqueOrThrow({ where: { id: termId } });
    return { term, clock, account: await loadAccount(tx, before.entityId) };
  }
  async function event(
    tx: Tx,
    ctx: IdentityContext,
    clock: LedgerClock,
    term: SubscriptionTerm,
    type: "refund_suspended" | "refund_resumed" | "refunded" | "cancelled" | "rolled_over",
    payload: Prisma.InputJsonObject,
  ) {
    await tx.subscriptionEvent.create({
      data: {
        id: uuidv7(),
        entityId: term.entityId,
        subscriptionTermId: term.id,
        type,
        occurredAt: clock.now,
        bizDate: toDateColumn(clock.today),
        ...actorColumns(ctx.actor),
        payload: {
          ...payload,
          dailySnapshot: await captureSubscriptionDailySnapshot(tx, term.entityId, term.id),
        },
        createdAt: clock.now,
      },
    });
    await deps.onStep?.("subscription_event.insert");
  }
  async function emit(
    tx: Tx,
    ctx: IdentityContext,
    term: SubscriptionTerm,
    action: "refund_suspended" | "refund_resumed" | "refunded",
    source: string | { paymentExceptionId: string },
  ) {
    const requestId = typeof source === "string" ? source : source.paymentExceptionId;
    const base = {
      aggregate: { type: "subscription_term", id: term.id },
      entityId: term.entityId,
      storeId: null,
      dedupeKey: `billing.subscription.${action}:${requestId}`,
    };
    if (action === "refunded")
      await deps.events.emit(tx, ctx, {
        ...base,
        type: "billing.subscription.refunded",
        payload: {
          v: 1,
          termId: term.id,
          entityId: term.entityId,
          ...(typeof source === "string" ? { refundRequestId: source } : source),
          termStatus: term.status === "scheduled" ? "cancelled" : "refunded",
        },
      });
    else {
      if (typeof source !== "string") throw new TypeError("退款闸门事件必须来自退款申请");
      await deps.events.emit(tx, ctx, {
        ...base,
        type: `billing.subscription.${action}`,
        payload: { v: 1, termId: term.id, entityId: term.entityId, refundRequestId: source },
      });
    }
    await deps.onStep?.("event.emit");
  }
  async function suspendTermForRefund(
    tx: Tx,
    ctx: IdentityContext,
    input: { termId: string; refundRequestId: string; requestNo: string; rule: PlanRefundRule },
  ) {
    const { term, clock, account } = await enter(tx, input.termId);
    if (term.refundRequestId === input.refundRequestId && term.refundRule === input.rule) return;
    const facts = await previewPlanRefund(tx, term.id);
    refuse([
      ...(!["scheduled", "active"].includes(term.status) || term.refundRequestId
        ? ["term_not_refundable"]
        : []),
      ...(input.rule !== "override" && !facts.unused ? ["points_used"] : []),
      ...(input.rule !== "override" && facts.upgraded ? ["term_upgraded"] : []),
      ...(input.rule === "window" && !facts.withinWindow ? ["outside_window"] : []),
    ]);
    await tx.subscriptionTerm.update({
      where: { id: term.id },
      data: {
        refundRequestId: input.refundRequestId,
        refundRule: input.rule,
        updatedAt: clock.now,
      },
    });
    await deps.onStep?.("term.update");
    if (account.currentSubscriptionTermId === term.id)
      await writeOperation(tx, deps, clock, account, {
        opKey: `refund_suspend:${input.requestNo}`,
        opType: "refund_suspend",
        ref: { type: "refund_request", id: input.refundRequestId },
        occurredAt: clock.now,
        bizDate: clock.today,
        title: null,
        ctx,
        gateOpen: false,
      });
    await event(tx, ctx, clock, term, "refund_suspended", {
      refundRequestId: input.refundRequestId,
      rule: input.rule,
    });
    await selfCheck(tx, clock);
    await emit(tx, ctx, term, "refund_suspended", input.refundRequestId);
  }
  async function resumeTermFromRefund(
    tx: Tx,
    ctx: IdentityContext,
    input: { termId: string; refundRequestId: string; requestNo: string },
  ) {
    const { term, clock, account } = await enter(tx, input.termId);
    const previous = await tx.subscriptionEvent.findFirst({
      where: {
        subscriptionTermId: term.id,
        type: "refund_resumed",
        payload: { path: ["refundRequestId"], equals: input.refundRequestId },
      },
    });
    if (previous) return;
    refuse(term.refundRequestId !== input.refundRequestId ? ["term_not_refundable"] : []);
    await tx.subscriptionTerm.update({
      where: { id: term.id },
      data: { refundRequestId: null, refundRule: null, updatedAt: clock.now },
    });
    await deps.onStep?.("term.update");
    if (account.currentSubscriptionTermId === term.id)
      await writeOperation(tx, deps, clock, account, {
        opKey: `refund_resume:${input.requestNo}`,
        opType: "refund_resume",
        ref: { type: "refund_request", id: input.refundRequestId },
        occurredAt: clock.now,
        bizDate: clock.today,
        title: null,
        ctx,
        gateOpen: account.subStatus === "active" && !(await isRefundPending(tx, term.entityId)),
      });
    await event(tx, ctx, clock, term, "refund_resumed", {
      refundRequestId: input.refundRequestId,
      rule: term.refundRule,
    });
    await selfCheck(tx, clock);
    await emit(tx, ctx, term, "refund_resumed", input.refundRequestId);
  }
  /** 预约链从尾向头移动；已发放计划和其他周期已消费事实绝不重写。 */
  async function shift(
    tx: Tx,
    clock: LedgerClock,
    terms: SubscriptionTerm[],
    first: { startsAt: Date; startDate: string; anchorDay: number },
  ) {
    let start = first;
    const updates = [];
    for (const term of terms) {
      const anchor =
        boundary(start.startDate, start.anchorDay, 0) === start.startDate
          ? start.anchorDay
          : Number(start.startDate.slice(8));
      const dates = termDates(start.startDate, term.months, anchor),
        endsAt = endOfDay(addDays(dates.endDate, term.extendedDays));
      const schedules = await tx.grantSchedule.findMany({
        where: { subscriptionTermId: term.id },
        orderBy: { monthNo: "asc" },
      });
      if (schedules.length !== term.months || schedules.some((s) => s.status !== "pending"))
        throw new Error("REFUND_TERM_CHAIN_INVALID");
      updates.push({ term, dates, startsAt: start.startsAt, endsAt, schedules });
      start = {
        startsAt: endsAt,
        startDate: addDays(dates.endDate, term.extendedDays + 1),
        anchorDay: dates.anchorDay,
      };
    }
    for (const u of updates.toReversed()) {
      await tx.subscriptionTerm.update({
        where: { id: u.term.id },
        data: {
          startsAt: u.startsAt,
          endsAt: u.endsAt,
          startDate: toDateColumn(u.dates.startDate),
          endDate: toDateColumn(addDays(u.dates.endDate, u.term.extendedDays)),
          anchorDay: u.dates.anchorDay,
          updatedAt: clock.now,
        },
      });
      const dates = grantDates(u.dates);
      for (const s of u.schedules) {
        const day = dates[s.monthNo];
        if (!day) throw new Error("REFUND_GRANT_MONTH_INVALID");
        await tx.grantSchedule.update({
          where: { id: s.id },
          data: {
            dueAt: s.monthNo === 0 ? u.startsAt : startOfDay(day),
            dueDate: toDateColumn(day),
            updatedAt: clock.now,
          },
        });
      }
      await deps.onStep?.("term.update");
    }
  }
  async function revoke(
    tx: Tx,
    ctx: IdentityContext,
    input:
      { termId: string; refundRequestId: string } | { termId: string; paymentExceptionId: string },
  ) {
    const external = "paymentExceptionId" in input;
    const ref = external
      ? { type: "payment_exception" as const, id: input.paymentExceptionId }
      : { type: "refund_request" as const, id: input.refundRequestId };
    const source = external
      ? { paymentExceptionId: input.paymentExceptionId }
      : { refundRequestId: input.refundRequestId };
    if (external) {
      const initial = await tx.subscriptionTerm.findUniqueOrThrow({ where: { id: input.termId } });
      await acquireAccount(tx, deps.clock, initial.entityId);
      const held = await tx.subscriptionTerm.findUniqueOrThrow({ where: { id: input.termId } });
      if (held.refundRequestId)
        return {
          revokedPoints: 0,
          cancelledSchedules: 0,
          billingOrderIds: [],
          unrecoveredPoints: 0,
          heldByRefundRequestId: held.refundRequestId,
        };
    }
    const { term, clock, account } = await enter(tx, input.termId);
    const opKey = `revoke:subscription_term:${term.id}`,
      existing = await findOperation(tx, opKey);
    if (existing) {
      if (
        !external &&
        (existing.refType !== "refund_request" || existing.refId !== input.refundRequestId)
      )
        throw new AppError("PLAN_REFUND_NOT_ELIGIBLE");
      const first = await tx.subscriptionEvent.findFirst({
        where: { subscriptionTermId: term.id, type: { in: ["refunded", "cancelled"] } },
        orderBy: { seq: "asc" },
      });
      const result = resultSchema.parse(first?.payload);
      const payload = first?.payload;
      const unrecovered =
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        typeof payload.unrecoveredPoints === "number"
          ? payload.unrecoveredPoints
          : 0;
      return { ...result, unrecoveredPoints: unrecovered, heldByRefundRequestId: null };
    }
    if (external && term.refundRequestId)
      return {
        revokedPoints: 0,
        cancelledSchedules: 0,
        billingOrderIds: [],
        unrecoveredPoints: 0,
        heldByRefundRequestId: term.refundRequestId,
      };
    refuse(
      !["scheduled", "active", "ended"].includes(term.status) ||
        (!external && term.refundRequestId !== input.refundRequestId)
        ? ["term_not_refundable"]
        : [],
    );
    const facts = await previewPlanRefund(tx, term.id);
    refuse(!external && term.refundRule !== "override" && !facts.unused ? ["points_used"] : []);
    const lots = await tx.pointLot.findMany({
      where: { subscriptionTermId: term.id },
      orderBy: { id: "asc" },
    });
    const moves: BucketMove[] = lots.flatMap((lot) => [
      ...(lot.availableQty
        ? [{ lot, from: "available" as const, to: "revoked" as const, qty: lot.availableQty }]
        : []),
      ...(lot.expiredQty
        ? [{ lot, from: "expired" as const, to: "revoked" as const, qty: lot.expiredQty }]
        : []),
    ]);
    const cancelled = await tx.grantSchedule.updateMany({
      where: { subscriptionTermId: term.id, status: "pending" },
      data: { status: "cancelled", updatedAt: clock.now },
    });
    await tx.subscriptionTerm.update({
      where: { id: term.id },
      data: {
        status: term.status === "scheduled" ? "cancelled" : "refunded",
        refundedAt: clock.now,
        refundRequestId: null,
        refundRule: null,
        updatedAt: clock.now,
      },
    });
    await deps.onStep?.("term.update");
    // 批次先按旧current归属扣缓存，再切新周期；否则旧批次可用会残留在账户缓存。
    await writeOperation(tx, deps, clock, account, {
      opKey,
      opType: "revoke",
      ref,
      occurredAt: clock.now,
      bizDate: clock.today,
      title: null,
      ctx,
      moves,
      gateOpen:
        account.currentSubscriptionTermId !== term.id &&
        account.subStatus === "active" &&
        !(await isRefundPending(tx, term.entityId)),
    });
    const later = await tx.subscriptionTerm.findMany({
      where: { entityId: term.entityId, status: "scheduled", startsAt: { gte: term.endsAt } },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });
    const shifted = term.status === "scheduled" || account.currentSubscriptionTermId === term.id;
    if (term.status === "scheduled")
      await shift(tx, clock, later, {
        startsAt: term.startsAt,
        startDate: fromDateColumn(term.startDate),
        anchorDay: term.anchorDay,
      });
    if (account.currentSubscriptionTermId === term.id) {
      await shift(tx, clock, later, {
        startsAt: clock.now,
        startDate: clock.today,
        anchorDay: Number(clock.today.slice(8)),
      });
      const nextId = later[0]?.id;
      const otherActive = await tx.subscriptionTerm.count({
        where: { entityId: term.entityId, id: { not: term.id }, activatedAt: { not: null } },
      });
      await tx.billingAccount.update({
        where: { entityId: term.entityId },
        data: {
          subStatus: nextId ? "active" : otherActive ? "expired" : "none",
          currentSubscriptionTermId: nextId ?? null,
          updatedAt: clock.now,
        },
      });
      account.currentSubscriptionTermId = nextId ?? null;
      account.subStatus = nextId ? "active" : otherActive ? "expired" : "none";
      if (nextId) {
        const next = await tx.subscriptionTerm.update({
          where: { id: nextId },
          data: { status: "active", activatedAt: clock.now, updatedAt: clock.now },
        });
        const first = await tx.grantSchedule.findUniqueOrThrow({
          where: { subscriptionTermId_monthNo: { subscriptionTermId: nextId, monthNo: 0 } },
        });
        await grantDue(tx, deps, clock, account, next, first, ctx);
        await event(tx, ctx, clock, next, "rolled_over", {
          maxStores: next.maxStores,
          maxMembers: next.maxMembers,
        });
        await deps.events.emit(tx, ctx, {
          type: "billing.subscription.rolled_over",
          aggregate: { type: "subscription_term", id: nextId },
          payload: { v: 1, termId: nextId, prevTermId: term.id, entityId: term.entityId },
          entityId: term.entityId,
          storeId: null,
          dedupeKey: `billing.subscription.rolled_over:${nextId}`,
        });
      } else
        await writeOperation(tx, deps, clock, account, {
          opKey: `refund_addon_suspend:${ref.id}`,
          opType: "addon_suspend",
          ref,
          occurredAt: clock.now,
          bizDate: clock.today,
          title: null,
          ctx,
          gateOpen: false,
        });
    }
    await refreshNextDue(tx, clock, account);
    // 非当前周期退款也可能解除唯一主体闸门，末次空操作的余额需与剩余闸门一致。
    await selfCheck(tx, clock);
    const result = {
      revokedPoints: moves.reduce((n, m) => n + m.qty, 0),
      cancelledSchedules: cancelled.count,
      billingOrderIds: [...facts.billingOrderIds],
      unrecoveredPoints: external
        ? lots.reduce((n, lot) => n + lot.heldQty + lot.consumedQty + lot.convertedOutQty, 0)
        : 0,
      heldByRefundRequestId: null,
    };
    await event(tx, ctx, clock, term, term.status === "scheduled" ? "cancelled" : "refunded", {
      revokedPoints: result.revokedPoints,
      cancelledSchedules: result.cancelledSchedules,
      billingOrderIds: result.billingOrderIds,
      ...(external ? { unrecoveredPoints: result.unrecoveredPoints } : {}),
      ...source,
      rule: external ? "override" : term.refundRule,
      affectedTerms: shifted
        ? await Promise.all(
            (
              await tx.subscriptionTerm.findMany({
                where: {
                  id: { in: later.map((t) => t.id) },
                  entityId: term.entityId,
                  status: "scheduled",
                },
                orderBy: [{ startsAt: "asc" }, { id: "asc" }],
              })
            ).map((t) => captureSubscriptionDailySnapshot(tx, term.entityId, t.id)),
          )
        : [],
    });
    await emit(
      tx,
      ctx,
      term,
      "refunded",
      external ? { paymentExceptionId: input.paymentExceptionId } : input.refundRequestId,
    );
    return result;
  }
  async function revokeTerm(
    tx: Tx,
    ctx: IdentityContext,
    input: { termId: string; refundRequestId: string },
  ): Promise<RevokeTermResult> {
    const result = await revoke(tx, ctx, input);
    // 旧申请入口维持原返回契约，且仍只允许本申请持有闸门。
    return {
      revokedPoints: result.revokedPoints,
      cancelledSchedules: result.cancelledSchedules,
      billingOrderIds: result.billingOrderIds,
    };
  }
  async function revokeTermForExternalRefund(
    tx: Tx,
    ctx: IdentityContext,
    input: { termId: string; paymentExceptionId: string },
  ) {
    const exception = await tx.paymentException.findUnique({
      where: { id: input.paymentExceptionId },
    });
    const term = await tx.subscriptionTerm.findUnique({ where: { id: input.termId } });
    if (
      !exception ||
      exception.kind !== "refund_bill_only" ||
      exception.status !== "open" ||
      !term ||
      exception.entityId !== term.entityId ||
      !exception.billingOrderId ||
      (term.sourceBillingOrderId !== exception.billingOrderId &&
        !(await tx.subscriptionEvent.count({
          where: {
            subscriptionTermId: term.id,
            type: "upgraded",
            billingOrderId: exception.billingOrderId,
          },
        })))
    )
      throw new AppError("PLAN_REFUND_NOT_ELIGIBLE");
    return revoke(tx, ctx, input);
  }
  return {
    previewPlanRefund,
    suspendTermForRefund,
    resumeTermFromRefund,
    revokeTerm,
    revokeTermForExternalRefund,
  };
}
