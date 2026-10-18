import {
  BillingAdjustmentApprovalSchema,
  PointAdjustmentRequestDetailSchema,
  TermExtensionRequestDetailSchema,
} from "@liyoxi/contract";
import type { ApprovalRequest } from "@liyoxi/db";
import { byEntity, satisfiesLevel } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { entityRef, staffBrief } from "../payment/purchase-read.js";
import { getWalletView } from "../read/index.js";
import { fromDateColumn } from "../ledger/context.js";
import type { BillingAdjustmentDeps } from "./context.js";
import { extensionQuote } from "./quotes.js";

export function adjustmentReadable(
  staff: StaffContext,
  kind: "points_adjust" | "subscription_extend",
) {
  return (
    kind === "points_adjust" ? (["billing", "finance"] as const) : (["order", "billing"] as const)
  ).some((module) => satisfiesLevel(staff.moduleLevels[module], "view"));
}
export async function assertAdjustmentVisible(
  tx: Tx,
  staff: StaffContext,
  row: ApprovalRequest,
  write = false,
) {
  if (
    !write &&
    !adjustmentReadable(
      staff,
      row.kind === "points_adjust" ? "points_adjust" : "subscription_extend",
    )
  )
    throw new AppError("PERMISSION_DENIED");
  if (row.requesterStaffId === staff.staff.id) return;
  if (
    !row.entityId ||
    !(await tx.billingAccount.findFirst({
      where: { entityId: row.entityId, ...byEntity(staff.scope) },
      select: { entityId: true },
    }))
  )
    throw new AppError("NOT_FOUND");
}
async function approvalView(
  tx: Tx,
  deps: BillingAdjustmentDeps,
  staff: StaffContext,
  row: ApprovalRequest,
) {
  const requester = await staffBrief(tx, row.requesterStaffId),
    role = requester
      ? await tx.staffRole.findUnique({ where: { key: requester.roleKey }, select: { name: true } })
      : null;
  // 写接口只有动作权限，不额外要求模块查看等级；授权写后的回显保持事实，动作提示保守为空。
  const base = adjustmentReadable(
    staff,
    row.kind === "points_adjust" ? "points_adjust" : "subscription_extend",
  )
    ? await deps.approval.decisionView(tx, staff, row.id)
    : {
        approvalId: row.id,
        kind: row.kind,
        status: row.status,
        roundNo: row.roundNo,
        submittedAt: row.submittedAt.toISOString(),
        dueAt: row.dueAt?.toISOString() ?? null,
        badges: [],
        requester,
        decidedBy: await staffBrief(tx, row.decidedByStaffId),
        isDecidedBySystem: row.isDecidedBySystem,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decisionNote: row.decisionNote,
        reasons: await Promise.all(
          row.reasonCodes.map(async (code) => ({
            code,
            name:
              (
                await tx.dictItem.findUnique({
                  where: { dictTypeKey_code: { dictTypeKey: "reject_reason", code } },
                })
              )?.name ?? code,
          })),
        ),
        lockVersion: row.lockVersion,
        actions:
          row.status === "pending" && row.requesterStaffId === staff.staff.id ? ["withdraw"] : [],
      };
  return BillingAdjustmentApprovalSchema.parse({
    ...base,
    requestNo: row.requestNo,
    requesterRoleName: role ? `${role.name}${requester?.isLead ? "主管" : ""}` : null,
    confirmChecks: row.confirmChecks,
  });
}
export async function pointAdjustmentDetail(
  tx: Tx,
  deps: BillingAdjustmentDeps,
  staff: StaffContext,
  id: string,
  write = false,
) {
  const r = await tx.pointAdjustmentRequest.findUnique({
    where: { id },
    include: { approvalRequest: true },
  });
  if (!r) throw new AppError("NOT_FOUND");
  await assertAdjustmentVisible(tx, staff, r.approvalRequest, write);
  const wallet = await getWalletView(tx, r.entityId, deps.clock.now()),
    hold = r.pointHoldId ? await tx.pointHold.findUnique({ where: { id: r.pointHoldId } }) : null,
    extension = r.termExtensionRequestId
      ? await tx.termExtensionRequest.findUnique({
          where: { id: r.termExtensionRequestId },
          include: { approvalRequest: true },
        })
      : null,
    operation = r.ledgerOperationId
      ? await tx.ledgerOperation.findUniqueOrThrow({ where: { id: r.ledgerOperationId } })
      : null,
    approval = await approvalView(tx, deps, staff, r.approvalRequest),
    signedPoints = (r.direction === "increase" ? 1 : -1) * r.adjustPoints;
  return PointAdjustmentRequestDetailSchema.parse({
    pointAdjustmentRequestId: r.id,
    requestNo: r.approvalRequest.requestNo,
    entity: await entityRef(tx, r.entityId),
    direction: r.direction,
    lotKind: r.lotKind,
    adjustPoints: r.adjustPoints,
    signedPoints,
    reasonCode: r.reasonCode,
    note: r.note,
    pointHold: hold
      ? {
          pointHoldId: hold.id,
          purpose: hold.purpose,
          groupRef: hold.groupRef,
          qty: hold.qty,
          status: hold.status,
        }
      : null,
    termExtensionRequest: extension
      ? { termExtensionRequestId: extension.id, requestNo: extension.approvalRequest.requestNo }
      : null,
    spendableBeforePoints: r.spendableBeforePoints,
    spendableAfterPreviewPoints: r.spendableBeforePoints + signedPoints,
    currentSpendablePoints: wallet.points.spendablePoints,
    applied:
      operation && r.appliedAt
        ? {
            ledgerOperationId: operation.id,
            appliedAt: r.appliedAt.toISOString(),
            spendableAfterPoints: operation.spendableAfterQty,
          }
        : null,
    relatedServiceTickets: await deps.refs.list(tx, {
      entityId: r.entityId,
      approvalRequestId: r.approvalRequestId,
    }),
    approval,
    actions: approval.actions,
  });
}
export async function termExtensionDetail(
  tx: Tx,
  deps: BillingAdjustmentDeps,
  staff: StaffContext,
  id: string,
  write = false,
) {
  const r = await tx.termExtensionRequest.findUnique({
    where: { id },
    include: { approvalRequest: true, subscriptionTerm: { include: { plan: true } } },
  });
  if (!r) throw new AppError("NOT_FOUND");
  await assertAdjustmentVisible(tx, staff, r.approvalRequest, write);
  const reason = await tx.dictItem.findUnique({
      where: { dictTypeKey_code: { dictTypeKey: "extend_reason", code: r.reasonCode } },
    }),
    linked = await tx.pointAdjustmentRequest.findMany({
      where: { termExtensionRequestId: r.id, entityId: r.entityId },
      include: { approvalRequest: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    }),
    approval = await approvalView(tx, deps, staff, r.approvalRequest);
  return TermExtensionRequestDetailSchema.parse({
    termExtensionRequestId: r.id,
    requestNo: r.approvalRequest.requestNo,
    entity: await entityRef(tx, r.entityId),
    subscriptionTerm: {
      subscriptionTermId: r.subscriptionTerm.id,
      planName: r.subscriptionTerm.plan.name,
      startDate: fromDateColumn(r.subscriptionTerm.startDate),
      endDate: fromDateColumn(r.subscriptionTerm.endDate),
    },
    days: r.days,
    reason: { code: r.reasonCode, name: reason?.name ?? r.reasonCode },
    note: r.note,
    preview:
      r.approvalRequest.status === "pending"
        ? await extensionQuote(
            tx,
            r.entityId,
            r.subscriptionTermId,
            r.days,
            deps.clock.now(),
            r.approvalRequestId,
          )
        : null,
    applied:
      r.appliedAt &&
      r.appliedSubscriptionTermId &&
      r.appliedMode &&
      r.prevEndDate &&
      r.newEndDate &&
      r.ledgerOperationId
        ? {
            appliedSubscriptionTermId: r.appliedSubscriptionTermId,
            appliedMode: r.appliedMode,
            prevEndDate: fromDateColumn(r.prevEndDate),
            newEndDate: fromDateColumn(r.newEndDate),
            appliedAt: r.appliedAt.toISOString(),
            ledgerOperationId: r.ledgerOperationId,
          }
        : null,
    relatedAdjustments: linked.map((row) => ({
      pointAdjustmentRequestId: row.id,
      requestNo: row.approvalRequest.requestNo,
      status: row.approvalRequest.status,
    })),
    approval,
    actions: approval.actions,
  });
}
