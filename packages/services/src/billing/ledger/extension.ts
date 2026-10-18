// 补偿到期复活：调用方先锁审批单，再进入同一主体的账本。正常顺延仍走W4-05期限原语。
import { SUBSCRIPTION_EVENT_PAYLOADS } from "@liyoxi/contract";
import { addDays, diffDays, endOfDay } from "@liyoxi/shared/time";
import type { LocalDate } from "@liyoxi/shared/time";
import { actorColumns, AppError, uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { fromDateColumn, toDateColumn } from "./context.js";
import type { Entered } from "./hold.js";
import { findOperation, isRefundPending, reached, writeOperation } from "./operation.js";
import { refreshNextDue } from "./advance.js";
import { selfCheck } from "./self-check.js";
import type { ApplyExtensionInput } from "./subscription-operations.js";
import { LedgerError } from "./types.js";
import type { LedgerDeps } from "./types.js";
import { captureSubscriptionDailySnapshot } from "../reporting/snapshot.js";

export interface ReviveTermInput extends ApplyExtensionInput {
  readonly subscriptionTermId: string;
  /** 原申请在该周期生效时提交；不能到期后新造一次复活资格。 */
  readonly submittedAt: Date;
}
export interface ReviveTermResult {
  readonly operationId: string;
  readonly appliedSubscriptionTermId: string;
  readonly appliedMode: "revive";
  readonly prevEndDate: LocalDate;
  readonly newEndDate: LocalDate;
  readonly appliedAt: Date;
  readonly replayed: boolean;
}

export async function reviveTerm(
  tx: Tx,
  deps: LedgerDeps,
  { clock, account }: Entered,
  input: ReviveTermInput,
): Promise<ReviveTermResult> {
  const opKey = `extend:${input.requestNo}`;
  const existing = await findOperation(tx, opKey);
  if (existing) {
    const event = await tx.subscriptionEvent.findFirst({
      where: {
        entityId: input.entityId,
        type: "resumed",
        payload: { path: ["requestNo"], equals: input.requestNo },
      },
    });
    const first = SUBSCRIPTION_EVENT_PAYLOADS.resumed.parse(event?.payload);
    if (
      existing.entityId !== input.entityId ||
      existing.refId !== input.approvalRequestId ||
      existing.opType !== "extend" ||
      first.days !== input.days ||
      first.appliedSubscriptionTermId !== input.subscriptionTermId
    )
      throw new LedgerError("op_key_conflict", "复活操作键与首次入参不同");
    return {
      operationId: existing.id,
      appliedSubscriptionTermId: first.appliedSubscriptionTermId,
      appliedMode: "revive",
      prevEndDate: first.prevEndDate,
      newEndDate: first.newEndDate,
      appliedAt: existing.occurredAt,
      replayed: true,
    };
  }
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 90)
    throw new AppError("PRECONDITION_CHANGED", { details: { reason: "revive_not_allowed" } });
  if (await isRefundPending(tx, input.entityId))
    throw new AppError("PRECONDITION_CHANGED", { details: { reason: "refund_in_progress" } });
  const term = await tx.subscriptionTerm.findFirst({
    where: { entityId: input.entityId },
    orderBy: { termNo: "desc" },
  });
  if (!term || term.status === "refunded" || term.status === "cancelled")
    throw new AppError("PRECONDITION_CHANGED", { details: { reason: "no_term" } });
  if (
    account.subStatus !== "expired" ||
    account.currentSubscriptionTermId !== null ||
    term.id !== input.subscriptionTermId ||
    term.status !== "ended" ||
    term.refundRequestId ||
    term.refundedAt ||
    term.endsAt > clock.now ||
    input.submittedAt < term.startsAt ||
    input.submittedAt >= term.endsAt
  )
    throw new AppError("PRECONDITION_CHANGED", { details: { reason: "revive_not_allowed" } });
  const prevEndDate = fromDateColumn(term.endDate),
    newEndDate = addDays(
      prevEndDate > addDays(clock.today, -1) ? prevEndDate : addDays(clock.today, -1),
      input.days,
    ),
    newEndsAt = endOfDay(newEndDate),
    gapDays = Math.max(0, diffDays(clock.today, prevEndDate) - 1);
  const expiration = await findOperation(tx, `expire:subscription_term:${term.id}:${prevEndDate}`);
  if (!expiration) throw new LedgerError("guard", "复活缺少本次真实清零操作");
  const cleared = await tx.pointLedgerEntry.findMany({
    where: {
      ledgerOperationId: expiration.id,
      entityId: input.entityId,
      fromBucket: "available",
      toBucket: "expired",
    },
    include: { pointLot: true },
    orderBy: { seq: "asc" },
  });
  if (
    cleared.some(
      ({ pointLot: lot, qty }) =>
        lot.subscriptionTermId !== term.id || lot.kind !== "plan" || lot.expiredQty < qty,
    )
  )
    throw new LedgerError("guard", "复活清零来源不守恒");
  await tx.subscriptionTerm.update({
    where: { id: term.id },
    data: {
      status: "active",
      endedAt: null,
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
  const restored = await writeOperation(tx, deps, clock, account, {
    opKey: `unexpire:${input.requestNo}`,
    opType: "unexpire",
    ref: { type: "approval_request", id: input.approvalRequestId },
    occurredAt: clock.now,
    bizDate: clock.today,
    ctx: input.ctx,
    title: { code: "unexpire", args: { days: input.days } },
    // 只冲回最近清零操作的真实移动；其他取消/退回产生的forfeit不能被复活。
    moves: cleared.map(({ pointLot: lot, qty }) => ({
      lot,
      from: "expired",
      to: "available",
      qty,
    })),
    accountPatch: { subStatus: "active", currentSubscriptionTermId: term.id },
    gateOpen: true,
  });
  await selfCheck(tx, clock, restored);
  await writeOperation(tx, deps, clock, account, {
    opKey: `resume:subscription_term:${term.id}:${newEndDate}`,
    opType: "addon_resume",
    ref: { type: "subscription_term", id: term.id },
    occurredAt: clock.now,
    bizDate: clock.today,
    ctx: input.ctx,
    title: { code: "addon_resume", args: { termEndDate: newEndDate } },
    gateOpen: true,
  });
  const written = await writeOperation(tx, deps, clock, account, {
    opKey,
    opType: "extend",
    ref: { type: "approval_request", id: input.approvalRequestId },
    occurredAt: clock.now,
    bizDate: clock.today,
    ctx: input.ctx,
    title: null,
    gateOpen: true,
  });
  await tx.subscriptionEvent.create({
    data: {
      id: uuidv7(),
      entityId: input.entityId,
      subscriptionTermId: term.id,
      type: "resumed",
      occurredAt: clock.now,
      bizDate: toDateColumn(clock.today),
      createdAt: clock.now,
      ...actorColumns(input.ctx.actor),
      payload: {
        requestNo: input.requestNo,
        days: input.days,
        gapDays,
        appliedSubscriptionTermId: term.id,
        appliedMode: "revive",
        prevEndDate,
        newEndDate,
        dailySnapshot: await captureSubscriptionDailySnapshot(tx, input.entityId, term.id),
      },
    },
  });
  await reached(deps, "subscription_event.insert");
  await refreshNextDue(tx, clock, account);
  await selfCheck(tx, clock, written);
  return {
    operationId: written.id,
    appliedSubscriptionTermId: term.id,
    appliedMode: "revive",
    prevEndDate,
    newEndDate,
    appliedAt: clock.now,
    replayed: false,
  };
}
