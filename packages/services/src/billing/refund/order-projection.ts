import { PaymentOrderAdminDetailSchema } from "@liyoxi/contract";
import { byEntity } from "../../authz/index.js";
import type { DataScope } from "../../authz/index.js";
import type { Tx } from "../../kernel/index.js";

/** 付款单已按原scope读取；仍在退款侧核同单同scope，仅投影既有七字段。 */
export async function orderRefundProjection(tx: Tx, scope: DataScope, paymentOrderId: string) {
  const rows = await tx.refundRequest.findMany({
    where: { billingOrderId: paymentOrderId, ...byEntity(scope) },
    select: {
      id: true,
      ruleCode: true,
      amountFen: true,
      status: true,
      closeReason: true,
      createdAt: true,
      approvalRequest: { select: { requestNo: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return PaymentOrderAdminDetailSchema.shape.refundRequests.parse(
    rows.map((row) => ({
      refundRequestId: row.id,
      requestNo: row.approvalRequest.requestNo,
      ruleCode: row.ruleCode,
      amountFen: row.amountFen,
      status: row.status,
      closeReason: row.closeReason,
      createdAt: row.createdAt.toISOString(),
    })),
  );
}
