import { calendarDate } from "@liyoxi/shared/time";
import { createIdentityContext, isAppError, uuidv7 } from "../../kernel/index.js";
import { sampleStaffContext } from "../approval.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";
import type { AdminLiveFixtureContext } from "./context.js";

/** 仅复用本轮真实入账生成的周期；申请/自审负例都走已合领域公口，不造审批终态。 */
export async function prepareW418Approvals(
  { runtime, make }: AdminLiveFixtureContext,
  paid: { entityId: string; paymentOrderId: string },
  mark: (phase: string) => void,
) {
  assertDeliveryLiveEnvironment(runtime.env);
  if (runtime.providers.storage.status !== "fake") throw new Error("W418审批只接受隔离替身环境");
  mark("approval-proposer");
  const proposer = await make.staff({ name: "W418隔离审批发起人", staffRoleKey: "super_admin" });
  const staff = await runtime.tx.run((tx) =>
      sampleStaffContext(tx, proposer.id, { stepUpAt: runtime.clock.now() }),
    ),
    actor = {
      identity: createIdentityContext({
        actor: { type: "staff", id: proposer.id, client: "admin" },
      }),
      staff,
    },
    adjustments = runtime.billing.adjustments;
  mark("approval-term");
  const term = await runtime.tx.run((tx) =>
    tx.subscriptionTerm.findFirstOrThrow({
      where: {
        entityId: paid.entityId,
        sourceBillingOrderId: paid.paymentOrderId,
        status: "active",
      },
    }),
  );
  mark("approval-reason");
  const reason = await runtime.tx.run((tx) =>
    tx.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: "extend_reason", code: "EX418" } },
      create: {
        id: uuidv7(),
        dictTypeKey: "extend_reason",
        code: "EX418",
        name: "W418隔离延长补偿",
        createdAt: runtime.clock.now(),
        updatedAt: runtime.clock.now(),
      },
      update: {},
    }),
  );
  const input = {
    direction: "increase" as const,
    lotKind: "plan" as const,
    adjustPoints: 100,
    reasonCode: "compensation" as const,
    note: "W418实际异人审批补偿",
  };
  mark("approval-quote");
  const quote = await adjustments.adjustmentQuote(actor, paid.entityId, input);
  mark("approval-create");
  const point = await adjustments.points.create(actor, {
    ...input,
    pointAccountId: paid.entityId,
    confirm: { spendableBeforePoints: quote.spendableBeforePoints },
  });
  const extension = await adjustments.extensions.create(actor, {
    subscriptionTermId: term.id,
    days: 7,
    reasonCode: reason.code,
    note: "W418实际周期延长预览",
    confirm: { subscriptionTermId: term.id, endDate: calendarDate(term.endDate) },
  });
  const before = await runtime.tx.run((tx) =>
    tx.ledgerOperation.count({ where: { entityId: paid.entityId } }),
  );
  mark("approval-self-forbidden");
  for (const self of [
    () =>
      adjustments.points.approve(actor, point.pointAdjustmentRequestId, {
        lockVersion: point.approval.lockVersion,
        confirm: {
          requestNo: point.requestNo!,
          direction: point.direction,
          adjustPoints: point.adjustPoints,
        },
        confirmChecks: ["basis_checked"],
      }),
    () =>
      adjustments.extensions.approve(actor, extension.termExtensionRequestId, {
        lockVersion: extension.approval.lockVersion,
        confirm: { requestNo: extension.requestNo!, days: extension.days },
        confirmChecks: ["effect_preview_checked"],
      }),
  ]) {
    let denied = false;
    try {
      await self();
    } catch (error) {
      if (isAppError(error) && error.error === "APPROVAL_SELF_FORBIDDEN") denied = true;
      else throw error;
    }
    if (!denied) throw new Error("W418实际发起人自审未被拒绝");
  }
  const current = await adjustments.points.get(staff, point.pointAdjustmentRequestId),
    currentExtension = await adjustments.extensions.get(staff, extension.termExtensionRequestId),
    after = await runtime.tx.run((tx) =>
      tx.ledgerOperation.count({ where: { entityId: paid.entityId } }),
    );
  if (
    before !== after ||
    current.applied !== null ||
    current.approval.status !== "pending" ||
    current.currentSpendablePoints !== point.currentSpendablePoints ||
    currentExtension.applied !== null ||
    currentExtension.approval.status !== "pending"
  )
    throw new Error("W418自审拒绝后资金或审批事实变化");
  if (
    !point.requestNo ||
    !extension.requestNo ||
    !extension.preview ||
    extension.preview.mode === "not_applicable"
  )
    throw new Error("W418缺少真实可审批详情");
  return {
    requesterStaffId: proposer.id,
    selfApprovalRejectedWithoutLedgerWrites: true,
    point: {
      approvalId: point.approval.approvalId,
      id: point.pointAdjustmentRequestId,
      requestNo: point.requestNo,
      adjustPoints: point.adjustPoints,
      beforePoints: point.currentSpendablePoints,
    },
    extension: {
      approvalId: extension.approval.approvalId,
      id: extension.termExtensionRequestId,
      requestNo: extension.requestNo,
      days: extension.days,
      prevEndDate: extension.preview.prevEndDate,
      newEndDate: extension.preview.newEndDate,
    },
  };
}
