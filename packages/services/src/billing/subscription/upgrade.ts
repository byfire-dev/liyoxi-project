import type { BillingOrderContent, FulfillDone } from "@liyoxi/contract";
import type { BillingOrder } from "@liyoxi/db";
import { actorColumns, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import { toDateColumn } from "../ledger/context.js";
import type { LedgerClock } from "../ledger/context.js";
import type { AccountState } from "../ledger/operation.js";
import { isRefundPending } from "../ledger/operation.js";
import { grantUpgradeMonth } from "../ledger/subscription-operations.js";
import { FulfillBlockedError } from "./blocked.js";
import type { FulfillDeps } from "./types.js";

type UpgradeContent = Extract<BillingOrderContent, { kind: "upgrade" }>;
export async function fulfillUpgrade(
  tx: Tx,
  deps: FulfillDeps,
  clock: LedgerClock,
  account: AccountState,
  order: BillingOrder,
  content: UpgradeContent,
  ctx: IdentityContext,
): Promise<FulfillDone> {
  const term = await tx.subscriptionTerm.findUnique({ where: { id: content.termId } });
  if (
    !term ||
    term.entityId !== order.entityId ||
    term.status !== "active" ||
    term.id !== account.currentSubscriptionTermId ||
    clock.now >= term.endsAt
  )
    throw new FulfillBlockedError("UPGRADE_TERM_CHANGED");
  if (term.planRevisionId !== content.fromPlanRevisionId)
    throw new FulfillBlockedError("UPGRADE_PLAN_CHANGED");
  if (await isRefundPending(tx, order.entityId))
    throw new FulfillBlockedError("PLAN_REFUND_IN_PROGRESS");
  const payment = order.paidPaymentTxnId
    ? await tx.paymentTxn.findUnique({
        where: { id: order.paidPaymentTxnId },
        include: { transferProof: true },
      })
    : null;
  const actedAt =
    order.channel === "bank_transfer"
      ? payment?.transferProof?.uploadedAt
      : payment?.channelSuccessAt;
  if (!actedAt || actedAt >= new Date(content.validUntil))
    throw new FulfillBlockedError("UPGRADE_QUOTE_EXPIRED");
  const revision = await tx.planRevision.findUnique({ where: { id: content.toPlanRevisionId } });
  if (!revision)
    throw new FulfillBlockedError("UNEXPECTED", { problem: "target_revision_missing" });
  const schedules = await tx.grantSchedule.findMany({
    where: { subscriptionTermId: term.id },
    orderBy: { monthNo: "asc" },
  });
  if (
    schedules.length !== term.months ||
    !schedules.some((row) => row.monthNo === content.monthIndex && row.status === "granted")
  )
    throw new FulfillBlockedError("CONSTRAINT_VIOLATION", { problem: "upgrade_schedule_missing" });
  const lotIds: string[] = [];
  for (const schedule of schedules) {
    if (schedule.monthNo < content.monthIndex) continue;
    if (schedule.status === "granted")
      lotIds.push(
        ...(await grantUpgradeMonth(
          tx,
          deps,
          clock,
          account,
          { ...term, planId: revision.planId },
          order,
          content,
          schedule.monthNo,
          ctx,
        )),
      );
    else if (schedule.status === "pending")
      await tx.grantSchedule.update({
        where: { id: schedule.id },
        data: {
          points: revision.monthlyPoints,
          valueFen: schedule.valueFen + content.feeDeltaPerMonthFen,
          planId: revision.planId,
          planRevisionId: revision.id,
          updatedAt: clock.now,
        },
      });
    else
      throw new FulfillBlockedError("CONSTRAINT_VIOLATION", {
        problem: "upgrade_schedule_cancelled",
      });
  }
  await tx.subscriptionTerm.update({
    where: { id: term.id },
    data: {
      planId: revision.planId,
      planRevisionId: revision.id,
      monthlyEquivFen: revision.monthlyFeeFen,
      monthlyPoints: revision.monthlyPoints,
      discountBp: revision.discountBp,
      productionModel: revision.productionModel,
      maxStores: revision.maxStores,
      maxMembers: revision.maxMembers,
      schedulePriority: revision.schedulePriority,
      hasMonthlyReport: revision.hasMonthlyReport,
      updatedAt: clock.now,
    },
  });
  await deps.onStep?.("term.update");
  const payload = {
    monthIndex: content.monthIndex,
    remainingDays: content.remainingDays,
    baseDays: content.baseDays,
    remainingFullMonths: content.remainingFullMonths,
    feeDeltaPerMonthFen: content.feeDeltaPerMonthFen,
    pointsDeltaPerMonth: content.pointsDeltaPerMonth,
    proratedFen: content.proratedFen,
    payFen: content.payFen,
    topupPoints: content.topupPoints,
  };
  await tx.subscriptionEvent.create({
    data: {
      id: uuidv7(),
      entityId: order.entityId,
      subscriptionTermId: term.id,
      type: "upgraded",
      fromPlanId: term.planId,
      toPlanId: revision.planId,
      fromPlanRevisionId: term.planRevisionId,
      toPlanRevisionId: revision.id,
      billingOrderId: order.id,
      payload,
      occurredAt: clock.now,
      bizDate: toDateColumn(clock.today),
      ...actorColumns(ctx.actor),
      createdAt: clock.now,
    },
  });
  await deps.onStep?.("subscription_event.insert");
  await deps.events.emit(tx, ctx, {
    type: "billing.subscription.upgraded",
    aggregate: { type: "subscription_term", id: term.id },
    payload: {
      v: 1,
      termId: term.id,
      entityId: order.entityId,
      fromPlanId: term.planId,
      toPlanId: revision.planId,
    },
    dedupeKey: `billing.subscription.upgraded:${order.id}`,
    entityId: order.entityId,
    storeId: null,
  });
  await deps.onStep?.("event.emit");
  return {
    status: "done",
    effectiveAt: clock.now.toISOString(),
    termId: term.id,
    lotIds,
    queuedBehindActive: false,
    notes: [],
  };
}

export async function previousUpgrade(
  tx: Tx,
  order: BillingOrder,
  content: UpgradeContent,
): Promise<FulfillDone> {
  const event = await tx.subscriptionEvent.findFirst({
    where: { billingOrderId: order.id, type: "upgraded", subscriptionTermId: content.termId },
    orderBy: { seq: "asc" },
  });
  if (!event)
    throw new FulfillBlockedError("CONSTRAINT_VIOLATION", { problem: "upgraded_event_missing" });
  const lots = await tx.pointLot.findMany({
    where: { sourceType: "grant_upgrade", sourceId: order.id },
    orderBy: { sourceNo: "asc" },
    select: { id: true },
  });
  return {
    status: "done",
    effectiveAt: event.occurredAt.toISOString(),
    termId: content.termId,
    lotIds: lots.map((row) => row.id),
    queuedBehindActive: false,
    notes: [],
  };
}
