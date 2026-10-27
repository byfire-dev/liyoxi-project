import type { PaymentExceptionKindCode, PaymentResolutionCode } from "@liyoxi/contract";
import { hasPermission } from "../../../authz/index.js";
import type { StaffContext } from "../../../authz/index.js";

/** a07§4.3：仅列允许的人工作业；自动重分类不伪装为人工处理。 */
export const MATRIX = {
  paid_after_cancel: ["restore", "refund"],
  amount_mismatch: ["refund"],
  payer_mismatch: ["refund"],
  duplicate_receipt: ["refund"],
  fulfillment_blocked: ["retried", "refund"],
  bill_only: ["rebuild_order", "refund"],
  bank_unmatched: ["link_order", "offline_return"],
  platform_only: ["corrected"],
  status_mismatch: ["corrected"],
  refund_bill_only: ["record_channel_refund"],
  refund_platform_only: ["corrected"],
  refund_amount_mismatch: ["corrected"],
  refund_over: ["corrected", "written_off"],
  entitlement_unrecovered: ["corrected", "written_off"],
} satisfies Record<PaymentExceptionKindCode, PaymentResolutionCode[]>;
export function resolutions(
  row: { kind: string; status: string; billingOrderId: string | null },
  staff: StaffContext,
): PaymentResolutionCode[] {
  if (row.status !== "open" || !hasPermission(staff, "finance.recon.resolve")) return [];
  if (row.kind === "bill_only" && row.billingOrderId !== null) return [];
  return (MATRIX[row.kind as PaymentExceptionKindCode] ?? []).filter(
    (r) => r !== "written_off" || hasPermission(staff, "sys.super_admin"),
  );
}
