// 订阅升级的窄账本写者。调用方已持有同主体账户锁并完成advance；所有批次仍经原writeOperation落库。
import type { BillingOrder, SubscriptionTerm } from "@liyoxi/db";
import type { BillingOrderContent } from "@liyoxi/contract";
import { SUBSCRIPTION_EVENT_PAYLOADS } from "@liyoxi/contract";
import { grantDates, termDates } from "@liyoxi/shared/period";
import { addDays, endOfDay, startOfDay } from "@liyoxi/shared/time";
import type { LocalDate } from "@liyoxi/shared/time";
import { actorColumns, AppError, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { LedgerClock } from "./context.js";
import { fromDateColumn, toDateColumn } from "./context.js";
import type { AccountState } from "./operation.js";
import { findOperation, isRefundPending, reached, writeOperation } from "./operation.js";
import { refreshNextDue } from "./advance.js";
import { selfCheck } from "./self-check.js";
import { LedgerError } from "./types.js";
import type { LedgerDeps } from "./types.js";
import type { Entered } from "./hold.js";
import { captureSubscriptionDailySnapshot } from "../reporting/snapshot.js";

type UpgradeContent = Extract<BillingOrderContent, { kind: "upgrade" }>;

export async function grantUpgradeMonth(
  tx: Tx,
  deps: LedgerDeps,
  clock: LedgerClock,
  account: AccountState,
  term: SubscriptionTerm,
  order: BillingOrder,
  content: UpgradeContent,
  monthNo: number,
  ctx: IdentityContext,
): Promise<readonly string[]> {
  const opKey = `grant:upgrade:${order.id}:${monthNo}`;
  const existing = await findOperation(tx, opKey);
  if (existing)
    return (
      await tx.pointLot.findMany({
        where: { sourceType: "grant_upgrade", sourceId: order.id, sourceNo: monthNo },
        select: { id: true },
      })
    ).map((row) => row.id);
  const first = monthNo === content.monthIndex;
  const points = first ? content.topupPoints : content.pointsDeltaPerMonth;
  const cost = first ? content.proratedFen : content.feeDeltaPerMonthFen;
  const written = await writeOperation(tx, deps, clock, account, {
    opKey,
    opType: "grant",
    ref: { type: "billing_order", id: order.id },
    occurredAt: clock.now,
    bizDate: clock.today,
    ctx,
    gateOpen: true,
    title: {
      code: "grant_upgrade",
      args: {
        toMonthlyPoints: term.monthlyPoints + content.pointsDeltaPerMonth,
        fromMonthlyPoints: term.monthlyPoints,
        remainingDays: content.remainingDays,
        baseDays: content.baseDays,
        billingOrderNo: order.orderNo,
      },
    },
    newLots:
      points > 0
        ? [
            {
              kind: "plan",
              sourceType: "grant_upgrade",
              sourceId: order.id,
              sourceNo: monthNo,
              subscriptionTermId: term.id,
              planId: term.planId,
              planRevisionId: content.toPlanRevisionId,
              expiresAt: term.endsAt,
              qty: points,
              costBasisFen: cost,
            },
          ]
        : [],
  });
  await selfCheck(tx, clock, written);
  return written.lotIds;
}

export interface ApplyExtensionInput {
  readonly entityId: string;
  /** 已持有审批锁的执行器提供实际关联；这里不创建或批准审批单。 */
  readonly approvalRequestId: string;
  readonly requestNo: string;
  readonly days: number;
  readonly ctx: IdentityContext;
}
export interface ApplyExtensionResult {
  readonly operationId: string;
  readonly appliedSubscriptionTermId: string;
  readonly appliedMode: "extend";
  readonly prevEndDate: LocalDate;
  readonly newEndDate: LocalDate;
  readonly appliedAt: Date;
  readonly replayed: boolean;
}

/**
 * W405期限原语：仅顺延当前生效周期及预约链。W408执行器负责审批与到期复活/unexpire，
 * 不能把已过期账户送入这里当成正常延长；已发放计划及原购买快照不改。
 */
export async function applyExtension(
  tx: Tx,
  deps: LedgerDeps,
  { clock, account }: Entered,
  input: ApplyExtensionInput,
): Promise<ApplyExtensionResult> {
  const opKey = `extend:${input.requestNo}`;
  const existing = await findOperation(tx, opKey);
  if (existing) {
    const event = await tx.subscriptionEvent.findFirst({
      where: {
        entityId: input.entityId,
        type: "extended",
        payload: { path: ["requestNo"], equals: input.requestNo },
      },
      orderBy: { seq: "asc" },
    });
    const first = SUBSCRIPTION_EVENT_PAYLOADS.extended.parse(event?.payload);
    if (
      existing.entityId !== input.entityId ||
      existing.opType !== "extend" ||
      existing.refId !== input.approvalRequestId ||
      first.days !== input.days
    )
      throw new LedgerError("op_key_conflict", "延长操作键与第一次的入参不同");
    return {
      operationId: existing.id,
      appliedSubscriptionTermId: first.appliedSubscriptionTermId,
      appliedMode: "extend",
      prevEndDate: first.prevEndDate,
      newEndDate: first.newEndDate,
      appliedAt: existing.occurredAt,
      replayed: true,
    };
  }
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 90)
    throw new AppError("PRECONDITION_CHANGED");
  if (
    account.subStatus !== "active" ||
    !account.currentSubscriptionTermId ||
    (await isRefundPending(tx, input.entityId))
  )
    throw new AppError("PRECONDITION_CHANGED");
  const term = await tx.subscriptionTerm.findUniqueOrThrow({
    where: { id: account.currentSubscriptionTermId },
  });
  if (term.status !== "active" || term.endsAt <= clock.now)
    throw new AppError("PRECONDITION_CHANGED");
  const prevEndDate = fromDateColumn(term.endDate),
    newEndDate = addDays(prevEndDate, input.days),
    newEndsAt = endOfDay(newEndDate);
  const scheduled = await tx.subscriptionTerm.findMany({
    where: { entityId: input.entityId, status: "scheduled" },
    orderBy: { startsAt: "asc" },
    include: { grantSchedules: true },
  });
  let previous = { endDate: newEndDate, endsAt: newEndsAt };
  let originalEndsAt = term.endsAt;
  const shifted = scheduled.map((next) => {
    if (next.startsAt.getTime() !== originalEndsAt.getTime())
      throw new LedgerError("term_chain", "预约周期没有接在上一期的止点上");
    originalEndsAt = next.endsAt;
    if (
      next.grantSchedules.length !== next.months ||
      next.grantSchedules.some((s) => s.status !== "pending")
    )
      throw new LedgerError("guard", "预约周期存在非待发放计划");
    const dates = termDates(addDays(previous.endDate, 1), next.months),
      startsAt = previous.endsAt,
      endsAt = endOfDay(dates.endDate);
    previous = { endDate: dates.endDate, endsAt };
    return { next, dates, startsAt, endsAt };
  });
  // 周期区间从链尾向前修改；不在账户锁后新增业务锁。
  for (const { next, dates, startsAt, endsAt } of shifted.toReversed()) {
    await tx.subscriptionTerm.update({
      where: { id: next.id },
      data: {
        startDate: toDateColumn(dates.startDate),
        endDate: toDateColumn(dates.endDate),
        anchorDay: dates.anchorDay,
        startsAt,
        endsAt,
        updatedAt: clock.now,
      },
    });
    const dueDates = grantDates(dates);
    for (const schedule of next.grantSchedules) {
      const dueDate = dueDates[schedule.monthNo];
      if (!dueDate) throw new LedgerError("guard", "预约周期的月序不合法");
      await tx.grantSchedule.update({
        where: { id: schedule.id },
        data: {
          dueDate: toDateColumn(dueDate),
          dueAt: schedule.monthNo === 0 ? startsAt : startOfDay(dueDate),
          updatedAt: clock.now,
        },
      });
    }
    await reached(deps, "term.update");
  }
  await tx.subscriptionTerm.update({
    where: { id: term.id },
    data: {
      endDate: toDateColumn(newEndDate),
      endsAt: newEndsAt,
      extendedDays: { increment: input.days },
      updatedAt: clock.now,
    },
  });
  await reached(deps, "term.update");
  await tx.pointLot.updateMany({
    where: { entityId: input.entityId, subscriptionTermId: term.id },
    data: { expiresAt: newEndsAt, updatedAt: clock.now },
  });
  await reached(deps, "lot.update");
  const written = await writeOperation(tx, deps, clock, account, {
    opKey,
    opType: "extend",
    ref: { type: "approval_request", id: input.approvalRequestId },
    occurredAt: clock.now,
    bizDate: clock.today,
    ctx: input.ctx,
    gateOpen: true,
    title: null,
  });
  const payload = {
    requestNo: input.requestNo,
    days: input.days,
    appliedSubscriptionTermId: term.id,
    appliedMode: "extend" as const,
    prevEndDate,
    newEndDate,
  };
  for (const id of [term.id, ...shifted.map(({ next }) => next.id)]) {
    await tx.subscriptionEvent.create({
      data: {
        id: uuidv7(),
        entityId: input.entityId,
        subscriptionTermId: id,
        type: "extended",
        occurredAt: clock.now,
        bizDate: toDateColumn(clock.today),
        payload: {
          ...payload,
          dailySnapshot: await captureSubscriptionDailySnapshot(tx, input.entityId, id),
        },
        ...actorColumns(input.ctx.actor),
        createdAt: clock.now,
      },
    });
    await reached(deps, "subscription_event.insert");
  }
  await refreshNextDue(tx, clock, account);
  await selfCheck(tx, clock, written);
  return {
    operationId: written.id,
    appliedSubscriptionTermId: term.id,
    appliedMode: "extend",
    prevEndDate,
    newEndDate,
    appliedAt: clock.now,
    replayed: false,
  };
}
