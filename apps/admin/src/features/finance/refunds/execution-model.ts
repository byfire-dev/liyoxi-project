import {
  RefundExecuteBodySchema,
  RefundOfflineBodySchema,
  RefundRetryBodySchema,
  RefundNotAcceptedBodySchema,
} from "@liyoxi/contract";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { canAction, type AccessSnapshot } from "../../../lib/permissions";
import type { RefundDetail } from "./api";
import type {
  OfflineRefundDraft,
  RefundExecution,
  RefundExecutionCommand,
} from "./execution-types";

export const executionLabels = {
  execute: "执行微信退款",
  retry: "按原退款单重试",
  "confirm-not-accepted": "确认微信未受理",
  "record-offline": "登记线下退款",
} as const;
export const refundExecutionStamp = (row: RefundDetail) => JSON.stringify(row);
export function pendingRefundTxn(row: RefundDetail) {
  const pending = row.refundTxns.filter(
    (txn) => txn.channel === "wechat_jsapi" && txn.origin === "system" && txn.status === "created",
  );
  return pending.length === 1 ? pending[0] : undefined;
}
export function allowedRefundExecutions(row: RefundDetail, access: AccessSnapshot | null) {
  if (
    !canAction(access, "finance.refund.execute") ||
    row.source === "staging_probe" ||
    row.approval.kind !== "plan_refund"
  )
    return [];
  const txn = pendingRefundTxn(row);
  return (["execute", "retry", "confirm-not-accepted", "record-offline"] as const).filter(
    (action) => {
      if (!row.actions.includes(action)) return false;
      if (action === "execute")
        return (
          row.status === "pending_execution" &&
          row.allowedRoutes.includes("wechat_original") &&
          row.paymentTxn.channel === "wechat_jsapi" &&
          !!row.paymentTxn.channelTxnNo
        );
      if (action === "record-offline")
        return (
          row.status === "pending_execution" &&
          row.allowedRoutes.includes("offline") &&
          (!!row.entity ||
            (access?.dataScope === "all" && row.paymentTxn.channel !== "bank_transfer")) &&
          canAction(access, "finance.receipt.confirm")
        );
      return (
        row.status === "executing" &&
        !!txn &&
        (action === "retry"
          ? row.canRetry
          : row.canConfirmNotAccepted && txn.isRetryHalted && !!txn.lastSubmitAt)
      );
    },
  );
}
export const emptyOfflineRefund = (row: RefundDetail): OfflineRefundDraft => ({
  transferDate: "",
  bankSerialNo: "",
  payeeName: row.paymentTxn.channel === "bank_transfer" ? (row.entity?.name ?? "") : "",
  payeeBank: "",
  payeeAccount: "",
  receiptFileId: null,
  note: "",
});
export function refundExecutionCommand(
  row: RefundDetail,
  action: RefundExecution,
  draft: OfflineRefundDraft,
): RefundExecutionCommand {
  const confirm = { requestNo: row.requestNo, amountFen: row.amountFen };
  if (action === "execute")
    return {
      action,
      body: RefundExecuteBodySchema.parse({
        confirm: { ...confirm, channelTxnNo: row.paymentTxn.channelTxnNo },
        confirmChecks: ["original_txn_checked"],
      }),
    };
  if (action === "record-offline") {
    if (row.paymentTxn.channel !== "bank_transfer" && !draft.note.trim())
      throw new Error("非对公收款转线下退款须填写说明");
    return {
      action,
      body: RefundOfflineBodySchema.parse({
        ...draft,
        receiptFileId: draft.receiptFileId,
        note: draft.note.trim() || undefined,
        confirm,
        confirmChecks: ["offline_transfer_checked"],
      }),
    };
  }
  const txn = pendingRefundTxn(row);
  if (!txn) throw new Error("当前退款意图不唯一，请重新读取");
  const body = { confirm: { requestNo: row.requestNo, outRefundNo: txn.outRefundNo } };
  return action === "retry"
    ? { action, body: RefundRetryBodySchema.parse(body) }
    : { action, body: RefundNotAcceptedBodySchema.parse(body) };
}
/** 同一记录/快照/正文保留原key；关闭scope同步取消，迟到结果不发布。 */
export function createRefundExecutionIntent(makeKey = () => newIdempotencyKey("refund-execution")) {
  const keys = new Map<RefundExecution, { signature: string; key: string }>();
  let active = true,
    busy = false,
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
      busy = false;
      generation++;
      controller.abort();
    },
    async submit<T>(
      action: RefundExecution,
      fingerprint: unknown,
      send: (key: string, signal: AbortSignal) => Promise<T>,
    ) {
      if (!active || busy) return undefined;
      const signature = JSON.stringify(fingerprint),
        old = keys.get(action),
        intent = old?.signature === signature ? old : { signature, key: makeKey() },
        own = generation,
        signal = controller.signal;
      keys.set(action, intent);
      busy = true;
      try {
        const value = await send(intent.key, signal);
        if (!active || signal.aborted || generation !== own) return undefined;
        keys.delete(action);
        return value;
      } catch (error) {
        if (active && !signal.aborted && generation === own) throw error;
        return undefined;
      } finally {
        if (generation === own) busy = false;
      }
    },
  };
}
