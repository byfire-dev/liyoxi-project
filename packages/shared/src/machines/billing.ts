// billing 模块：付款单、退款申请、差异单、开票申请的状态迁移表。
// 每行：分组文档的行（分组:行号）、当前状态（null 是新建）、迁移事件码、新状态（SAME 是不改状态）；文档没写守卫的行尾是 NO_GUARD。
// 改这里的行，要在同一个 PR 改分组文档的那一行：pnpm machines:check 逐行对照。
import {
  BILLING_ORDER_STATUS,
  INVOICE_REQUEST_STATUS,
  PAYMENT_EXCEPTION_STATUS,
  REFUND_REQUEST_STATUS,
} from "@liyoxi/contract/enums";

import { NO_GUARD, SAME, chain } from "./define.js";

/** billing_order.status：docs/data-model/08-billing-payment.md */
export const billingOrder = chain("billing_order", "status", BILLING_ORDER_STATUS, [
  ["08:162", null, "billing_order.create", ["pending_payment"]],
  ["08:163", null, "billing_order.create", ["pending_payment"]],
  ["08:164", ["pending_payment"], "billing_order.apply_payment", ["paid"]],
  [
    "08:165",
    ["pending_payment", "pending_confirmation"],
    "billing_order.cancel_mismatch",
    ["cancelled"],
  ],
  ["08:166", ["pending_payment"], "billing_order.cancel", ["cancelled"]],
  ["08:167", ["pending_payment"], "billing_order.submit_proof", ["pending_confirmation"]],
  ["08:170", ["pending_confirmation"], "billing_order.reject_proof", ["pending_payment"]],
  ["08:171", ["pending_confirmation"], "billing_order.confirm_transfer", ["paid"]],
  ["08:173", ["pending_confirmation"], "billing_order.approve_review", ["paid"]],
  ["08:174", ["pending_payment", "pending_confirmation"], "billing_order.link_receipt", ["paid"]],
  ["08:175", ["pending_payment"], "billing_order.cancel", ["cancelled"]],
  ["08:176", ["cancelled"], "billing_order.restore", ["paid"]],
  ["08:177", ["paid"], "billing_order.refund", ["refunded"]],
]);

/** refund_request.status：docs/data-model/08-billing-payment.md */
export const refundRequest = chain("refund_request", "status", REFUND_REQUEST_STATUS, [
  ["08:523", null, "refund.submit", ["pending_approval"]],
  ["08:524", ["pending_approval"], "approval.approved", ["pending_execution"]],
  ["08:525", ["pending_approval"], "approval.rejected", ["not_executed"]],
  ["08:526", ["pending_approval"], "approval.withdrawn", ["not_executed"]],
  ["08:527", ["pending_execution"], "refund.execute", ["executing"]],
  ["08:528", ["pending_execution"], "refund.record_offline", ["done"]],
  ["08:529", ["pending_execution"], "refund.complete", ["done"]],
  ["08:530", ["pending_execution"], "refund.void", ["not_executed"]],
  ["08:531", ["executing"], "refund.complete", ["done"], NO_GUARD],
  ["08:532", ["executing"], "refund.fail", ["pending_execution"], NO_GUARD],
]);

/** payment_exception.status：docs/data-model/08-billing-payment.md */
export const paymentException = chain("payment_exception", "status", PAYMENT_EXCEPTION_STATUS, [
  ["08:760", null, "payment_exception.open", ["open"]],
  ["08:761", null, "payment_exception.record_healed", ["auto_healed"]],
  ["08:762", ["open"], "payment_exception.request_refund", ["resolving"]],
  ["08:763", ["resolving"], "payment_exception.complete_refund", ["resolved"]],
  ["08:764", ["resolving"], "payment_exception.reopen", ["open"]],
  ["08:765", ["open"], "payment_exception.retry_fulfill", ["resolved"]],
  ["08:766", ["open"], "payment_exception.resolve", ["resolved"]],
  ["08:767", ["open"], "payment_exception.reclassify", ["auto_healed"]],
  ["08:768", ["open"], "payment_exception.auto_heal", ["auto_healed"]],
]);

/** invoice_request.status：docs/data-model/08-billing-payment.md */
export const invoiceRequest = chain("invoice_request", "status", INVOICE_REQUEST_STATUS, [
  ["08:1110", null, "invoice.request", ["pending"]],
  ["08:1111", ["pending"], "invoice.issue", ["issued"]],
  ["08:1112", ["pending"], "invoice.issue", ["issued"]],
  ["08:1113", ["pending"], "invoice.reject", ["rejected"]],
  ["08:1114", ["pending"], "invoice.reject_refunded", ["rejected"]],
  ["08:1115", ["issued"], "invoice.request_red", ["red_pending"], NO_GUARD],
  ["08:1116", ["red_pending"], "invoice.issue_red", ["red_issued"]],
  ["08:1117", ["red_pending"], "invoice.cancel_red", ["issued"]],
  ["08:1133", ["pending"], "sla.recalculated", SAME],
]);
