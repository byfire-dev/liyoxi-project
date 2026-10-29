import { RefundCreateBodySchema } from "@liyoxi/contract";
import type { CashRefundQuote, RefundCreateBody } from "@liyoxi/contract";
import type { PaymentDetail } from "../../order/orders/payment-api";
import type { PaymentRow } from "../payments/api";
import { canAction, hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import { newIdempotencyKey } from "../../../lib/idempotency";

export interface RefundTarget {
  paymentOrderId: string;
  orderNo: string;
  entityId: string;
  entityName: string;
  paymentTransactionId: string;
}
export type RefundRule = RefundCreateBody["ruleCode"];
export interface RefundSnapshot {
  order: PaymentDetail;
  quote: CashRefundQuote;
}
export const refundRuleLabels: Record<RefundRule, string> = {
  window: "七天未使用窗口",
  qualification_failed: "资质终审不通过",
  override: "规则外退款（须说明）",
};
export const canRequestRefund = (access: AccessSnapshot | null) =>
  hasModuleLevel(access, "finance") && canAction(access, "order.refund.request");
export function paymentRefundTarget(row: PaymentRow): RefundTarget | undefined {
  return row.paymentOrder && row.entity && row.isApplied
    ? {
        paymentOrderId: row.paymentOrder.paymentOrderId,
        orderNo: row.paymentOrder.orderNo,
        entityId: row.entity.entityId,
        entityName: row.entity.name,
        paymentTransactionId: row.paymentTransactionId,
      }
    : undefined;
}
export const refundSnapshotStamp = (value: RefundSnapshot) => JSON.stringify(value);
export function eligibleRefundRules(value: CashRefundQuote, access: AccessSnapshot | null) {
  if (
    !canRequestRefund(access) ||
    !value.supported ||
    value.openRequest ||
    value.refundableFen <= 0
  )
    return [];
  return value.rules
    .filter(
      (row) =>
        row.eligible && (row.rule !== "override" || canAction(access, "refund.override.request")),
    )
    .map((row) => row.rule);
}
export function refundRequestBody(
  value: RefundSnapshot,
  ruleCode: RefundRule,
  reasonCode: string,
  note: string,
  access: AccessSnapshot | null,
): RefundCreateBody {
  if (!eligibleRefundRules(value.quote, access).includes(ruleCode))
    throw new Error("当前规则不可申请");
  return RefundCreateBodySchema.parse({
    ruleCode,
    reasonCode,
    ...(note.trim() ? { note: note.trim() } : {}),
    confirm: { orderNo: value.order.orderNo, amountFen: value.quote.refundableFen },
  });
}
/** 本弹层一个提交意图；未知结果同正文原key，卸载取消且丢弃迟到结果。 */
export function createRefundRequestIntent(makeKey = () => newIdempotencyKey("refund-request")) {
  let saved: { signature: string; key: string } | undefined,
    busy = false,
    active = true,
    generation = 0,
    controller = new AbortController();
  return {
    get pending() {
      return busy;
    },
    activate() {
      if (!active) {
        active = true;
        controller = new AbortController();
      }
    },
    close() {
      active = false;
      generation++;
      busy = false;
      controller.abort();
    },
    async submit<T>(body: unknown, send: (key: string, signal: AbortSignal) => Promise<T>) {
      if (!active || busy) return undefined;
      const signature = JSON.stringify(body);
      if (saved?.signature !== signature) saved = { signature, key: makeKey() };
      const own = generation,
        signal = controller.signal;
      busy = true;
      try {
        const result = await send(saved.key, signal);
        if (!active || signal.aborted || generation !== own) return undefined;
        saved = undefined;
        return result;
      } catch (error) {
        if (active && !signal.aborted && generation === own) throw error;
        return undefined;
      } finally {
        if (generation === own) busy = false;
      }
    },
  };
}
