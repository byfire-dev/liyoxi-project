import type { ReconMonth } from "@liyoxi/contract";
import type { AccessSnapshot } from "../../../lib/permissions";
import type { ExceptionDetail, RerunTarget } from "./types";
export const id = "0199e187-e72a-7000-8000-000000000001",
  orderId = "0199e187-e72a-7000-8000-000000000002";
export const access: AccessSnapshot = {
  staff: { id, name: "虚构对账员", roleKey: "finance", roleName: "财务" },
  moduleLevels: { finance: "e" },
  dataScope: "all",
  isLead: false,
  actions: ["finance.recon.resolve", "finance.receipt.confirm"],
  releases: {},
};
export function detail(): ExceptionDetail {
  return {
    paymentExceptionId: id,
    exceptionNo: "EX-FIXTURE-001",
    kind: "bank_unmatched",
    detectedBy: "manual",
    billDate: "2030-10-18",
    entity: null,
    paymentOrder: null,
    channelTxnNo: null,
    amountFen: 101,
    causeText: "虚构未关联收款",
    status: "open",
    resolution: "none",
    createdAt: "2030-10-18T04:00:00.000Z",
    resolvedAt: null,
    isOverdue: true,
    billFact: null,
    platformFact: { amountFen: 101, state: "succeeded" },
    paymentTxn: null,
    refundTxn: null,
    wxBillLine: null,
    allowedResolutions: ["link_order", "offline_return"],
    linkCandidates: [
      {
        paymentOrderId: orderId,
        orderNo: "PO-FIXTURE-001",
        entity: {
          entityId: orderId,
          name: "虚构主体",
          primaryStoreId: null,
          primaryStoreName: null,
          storeCount: 0,
          verificationStatus: "verified",
          managerStaff: null,
        },
        amountFen: 101,
        status: "pending",
        createdAt: "2030-10-18T03:00:00.000Z",
      },
    ],
    hints: [],
    resolutionNote: null,
    resolvedBy: null,
    refundRequest: null,
    lockVersion: 7,
    actions: ["resolve"],
  };
}
export function day(): RerunTarget {
  return {
    billDate: "2030-10-18",
    reconciliationId: id,
    platformPay: { count: 0, amountFen: "0" },
    billPay: null,
    bank: null,
    refund: null,
    feeFen: "0",
    diff: null,
    status: "wait",
    billFileStatus: null,
    runCount: 0,
    lastRunAt: null,
    actions: ["rerun"],
  };
}
export function month(): ReconMonth {
  return {
    month: "2030-10",
    items: [day()],
    overview: {
      platform: { count: 0, amountFen: "0", wechatCount: 0, bankCount: 0 },
      wechatBill: { count: 0, amountFen: "0", downloadedThrough: null },
      refund: { count: 0, amountFen: "0", isBillMatched: false },
      diff: {
        openCount: 1,
        openAmountFen: "101",
        resolvingCount: 0,
        earliestOpenBillDate: "2030-10-18",
      },
    },
    dayStatusCounts: { ok: 0, diff: 0, fixed: 0, wait: 1 },
    openExceptions: [detail()],
    prevMonthAllOk: false,
  };
}
