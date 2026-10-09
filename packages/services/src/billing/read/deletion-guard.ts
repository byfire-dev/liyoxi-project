import type { Tx } from "../../kernel/index.js";

/** m07 第1节：主体注销与后台关闭共用的计费未办结事项。 */
export interface BillingDeletionGuardCounts {
  readonly subscription_active: number;
  readonly payment_open: number;
  readonly refund_open: number;
  readonly invoice_open: number;
}

/** 只读调用方事务；关闭守卫按正式状态列计数，不用套餐展示缓存或起止现算。 */
export async function deletionGuard(tx: Tx, entityId: string): Promise<BillingDeletionGuardCounts> {
  const subscription_active = await tx.subscriptionTerm.count({
    where: { entityId, status: { in: ["active", "scheduled"] } },
  });
  const payment_open = await tx.billingOrder.count({
    where: {
      entityId,
      OR: [
        { status: { in: ["pending_payment", "pending_confirmation"] } },
        { hasOpenException: true },
      ],
    },
  });
  const refund_open = await tx.refundRequest.count({ where: { entityId, closedAt: null } });
  const invoice_open = await tx.invoiceRequest.count({
    where: { entityId, status: { in: ["pending", "red_pending"] } },
  });
  return { subscription_active, payment_open, refund_open, invoice_open };
}
