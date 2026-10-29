import { RefundRequestDetailSchema } from "@liyoxi/contract";
import type { AppServices } from "../../../app/services";
import { readFailure, requestIdTail } from "../../../lib/api-errors";
import {
  refundDecisionCommand,
  type RefundDecision,
  type RefundDecisionInput,
} from "./decision-model";
export class RefundDecisionFailure extends Error {
  constructor(
    readonly symbol: string,
    readonly status = 0,
    readonly tail: string | null = null,
  ) {
    super(symbol);
  }
}
export function refundDecisionError(error: unknown) {
  const labels: Readonly<Record<string, string>> = {
      VERSION_CONFLICT: "申请版本已变化，请重新核对",
      CONFIRM_MISMATCH: "金额或申请内容已变化，请重新核对",
      PRECONDITION_CHANGED: "处理条件已变化，请重新核对",
      STATE_NOT_ALLOWED: "申请已被处理，请重新核对",
      PERMISSION_DENIED: "当前权限不可处理此申请",
      APPROVAL_SELF_FORBIDDEN: "发起人不能审批自己的申请",
      STEP_UP_REQUIRED: "请完成再次验证后重试",
      VALIDATION_FAILED: "请核对处理说明和确认内容",
      REFUND_TXN_OPEN: "已有退款交易，当前不能作废",
      REFUND_ALREADY_REVOKED: "权益已回收，当前不能作废",
      RESPONSE_MISMATCH: "退款详情关联不一致，请重新读取",
    },
    message = error instanceof RefundDecisionFailure ? labels[error.symbol] : undefined;
  return `${message ?? "请求未确认成功，请用原意图重试"}${error instanceof RefundDecisionFailure && error.tail ? `（请求编号 ${error.tail}）` : ""}`;
}
export const refundNeedsReconfirm = (error: unknown) =>
  error instanceof RefundDecisionFailure &&
  (error.status === 409 ||
    ["VERSION_CONFLICT", "CONFIRM_MISMATCH", "PRECONDITION_CHANGED", "STATE_NOT_ALLOWED"].includes(
      error.symbol,
    ));
async function result<T>(value: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (value.data) return value.data.data;
  const response =
      value.error === undefined
        ? value.response
        : new Response(JSON.stringify(value.error), {
            status: value.response.status,
            headers: value.response.headers,
          }),
    failure = await readFailure(response);
  throw new RefundDecisionFailure(failure.symbol, failure.status, requestIdTail(failure.requestId));
}
export function createRefundDecisionsApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    async decide(
      detail: RefundDecisionInput,
      action: RefundDecision,
      note: string,
      key: string,
      signal: AbortSignal,
    ) {
      if (detail.source === "staging_probe" || detail.approval.kind !== "plan_refund")
        throw new RefundDecisionFailure("PERMISSION_DENIED");
      const command = refundDecisionCommand(detail, action, note),
        shared = {
          params: { path: { refundRequestId: detail.refundRequestId } },
          headers: { "Idempotency-Key": key },
          signal,
        };
      const response =
        command.action === "approve"
          ? await client.POST("/api/v1/admin/refund-requests/{refundRequestId}/approve", {
              ...shared,
              body: command.body,
            })
          : command.action === "reject"
            ? await client.POST("/api/v1/admin/refund-requests/{refundRequestId}/reject", {
                ...shared,
                body: command.body,
              })
            : command.action === "withdraw"
              ? await client.POST("/api/v1/admin/refund-requests/{refundRequestId}/withdraw", {
                  ...shared,
                  body: command.body,
                })
              : await client.POST("/api/v1/admin/refund-requests/{refundRequestId}/void", {
                  ...shared,
                  body: command.body,
                });
      const row = RefundRequestDetailSchema.parse(await result(response));
      if (
        row.refundRequestId !== detail.refundRequestId ||
        row.approval.approvalId !== detail.approval.approvalId ||
        row.approval.kind !== "plan_refund"
      )
        throw new RefundDecisionFailure("RESPONSE_MISMATCH");
      return row;
    },
  };
}
export type RefundDecisionsApi = ReturnType<typeof createRefundDecisionsApi>;
