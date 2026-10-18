import type { PendingBillingCancel } from "@liyoxi/contract";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

/** 账户所属已由调用方裁剪；只交本主体在途取消摘要，不暴露L3表或无界历史。 */
export async function readBillingPendingCancels(
  tx: Tx,
  entityId: string,
): Promise<PendingBillingCancel[]> {
  const rows = await tx.cancelRequest.findMany({
    where: { entityId, closedAt: null, status: { in: ["pending_approval", "pending_execution"] } },
    select: {
      id: true,
      kind: true,
      status: true,
      totalRefundPoints: true,
      approvalRequest: { select: { requestNo: true } },
      dramaOrder: { select: { orderNo: true } },
      ad: { select: { adNo: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
  });
  return rows.map((row) => {
    const targetNo =
      row.kind === "qualification_cancel"
        ? null
        : (row.dramaOrder?.orderNo ?? row.ad?.adNo ?? null);
    if (row.kind !== "qualification_cancel" && !targetNo)
      throw new AppError("INTERNAL", { message: "取消申请缺少真实目标" });
    return {
      cancelRequestId: row.id,
      requestNo: row.approvalRequest.requestNo,
      kind: row.kind,
      targetNo,
      refundPoints: row.totalRefundPoints,
      status: row.status,
    };
  });
}
