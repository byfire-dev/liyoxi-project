import type { AccessSnapshot } from "../../../lib/permissions";
import type { AdjustmentCase } from "./api";
export const ids = {
  actor: "0199e187-e72a-7000-8000-000000000001",
  requester: "0199e187-e72a-7000-8000-000000000002",
  pointApproval: "0199e187-e72a-7000-8000-000000000003",
  extensionApproval: "0199e187-e72a-7000-8000-000000000004",
  point: "0199e187-e72a-7000-8000-000000000005",
  extension: "0199e187-e72a-7000-8000-000000000006",
  entity: "0199e187-e72a-7000-8000-000000000007",
  term: "0199e187-e72a-7000-8000-000000000008",
};
export const at = "2030-10-18T04:00:00.000Z";
export const access: AccessSnapshot = {
  staff: { id: ids.actor, name: "虚构审批人", roleKey: "super_admin", roleName: "超级管理员" },
  moduleLevels: { finance: "v", billing: "v" },
  dataScope: "all",
  isLead: false,
  actions: ["billing.adjust.approve", "billing.extension.approve"],
  releases: {},
};
const requester: NonNullable<AdjustmentCase["row"]["approval"]["requester"]> = {
  staffId: ids.requester,
  staffNo: 1002,
  name: "虚构发起人",
  roleKey: "super_admin",
  status: "active",
  isLead: false,
};
const entity = {
  entityId: ids.entity,
  name: "虚构主体",
  primaryStoreId: null,
  primaryStoreName: null,
  storeCount: 1,
  verificationStatus: "verified",
  managerStaff: null,
};
function approval(kind: "points_adjust" | "subscription_extend") {
  return {
    approvalId: kind === "points_adjust" ? ids.pointApproval : ids.extensionApproval,
    kind,
    requestNo: kind === "points_adjust" ? "JF-TEST-1" : "YC-TEST-1",
    status: "pending" as const,
    roundNo: 1,
    submittedAt: at,
    dueAt: null,
    badges: [],
    requester,
    requesterRoleName: "超级管理员",
    decidedBy: null,
    isDecidedBySystem: false,
    decidedAt: null,
    decisionNote: null,
    reasons: [],
    lockVersion: 7,
    confirmChecks: [],
    actions: ["approve", "reject", "withdraw"] as ("approve" | "reject" | "withdraw")[],
  };
}
export function pointCase(): Extract<AdjustmentCase, { kind: "points_adjust" }> {
  return {
    kind: "points_adjust",
    row: {
      pointAdjustmentRequestId: ids.point,
      requestNo: "JF-TEST-1",
      entity,
      direction: "increase",
      lotKind: "plan",
      adjustPoints: 100,
      signedPoints: 100,
      reasonCode: "compensation",
      note: "虚构可核对的调整依据",
      pointHold: null,
      termExtensionRequest: null,
      spendableBeforePoints: 0,
      spendableAfterPreviewPoints: 100,
      currentSpendablePoints: 0,
      applied: null,
      relatedServiceTickets: [],
      approval: approval("points_adjust"),
      actions: ["approve", "reject", "withdraw"],
    },
  };
}
export function extensionCase(): Extract<AdjustmentCase, { kind: "subscription_extend" }> {
  return {
    kind: "subscription_extend",
    row: {
      termExtensionRequestId: ids.extension,
      requestNo: "YC-TEST-1",
      entity,
      subscriptionTerm: {
        subscriptionTermId: ids.term,
        planName: "虚构套餐",
        startDate: "2030-10-01",
        endDate: "2030-10-31",
      },
      days: 7,
      reason: { code: "EX001", name: "服务补偿" },
      note: "虚构延长依据",
      preview: {
        mode: "revive",
        targetSubscriptionTermId: ids.term,
        isTargetDifferent: false,
        days: 7,
        prevEndDate: "2030-10-31",
        newEndDate: "2030-11-07",
        newEndsAt: "2030-11-07T16:00:00.000Z",
        restorePoints: 0,
        shiftedTerms: [
          { subscriptionTermId: ids.point, startDate: "2030-11-08", endDate: "2030-12-07" },
        ],
        blockReasons: [],
      },
      applied: null,
      relatedAdjustments: [],
      approval: approval("subscription_extend"),
      actions: ["approve", "reject", "withdraw"],
    },
  };
}
export function genericDetail(value: AdjustmentCase) {
  return {
    ...value.row.approval,
    category: "approval",
    subjectType: "billing_account",
    subjectId: ids.entity,
    entityId: ids.entity,
    storeId: null,
    deliveryTicketId: null,
    summary: {
      title: "虚构审批",
      lines: [{ label: "调整数量", value: "100 积分" }],
      domain: {
        type:
          value.kind === "points_adjust" ? "point_adjustment_request" : "term_extension_request",
        id: value.kind === "points_adjust" ? ids.point : ids.extension,
      },
    },
    domain: {
      type: value.kind === "points_adjust" ? "point_adjustment_request" : "term_extension_request",
      id: value.kind === "points_adjust" ? ids.point : ids.extension,
    },
    submitter: { actorType: "staff", actorId: ids.requester, label: requester.name },
    handler: null,
    checklist: null,
    confirmChecks: [],
    sla: null,
    timeline: [],
    operations:
      value.kind === "points_adjust"
        ? {
            get: "admin.pointAdjustmentRequest.get",
            approve: "admin.pointAdjustmentRequest.approve",
            reject: "admin.pointAdjustmentRequest.reject",
            withdraw: "admin.pointAdjustmentRequest.withdraw",
          }
        : {
            get: "admin.termExtensionRequest.get",
            approve: "admin.termExtensionRequest.approve",
            reject: "admin.termExtensionRequest.reject",
            withdraw: "admin.termExtensionRequest.withdraw",
          },
  };
}
