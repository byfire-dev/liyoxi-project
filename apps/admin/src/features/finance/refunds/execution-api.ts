import { RefundRequestDetailSchema } from "@liyoxi/contract";
import type { AppServices } from "../../../app/services";
import { readFailure, requestIdTail } from "../../../lib/api-errors";
import { moneyText } from "../payments/model";
import type { RefundDetail } from "./api";
import type { RefundExecutionCommand } from "./execution-types";

export class RefundExecutionFailure extends Error {
  constructor(
    readonly symbol: string,
    readonly status = 0,
    readonly tail: string | null = null,
    readonly details: { refundableFen?: number; serialNormalized?: string } = {},
  ) {
    super(symbol);
  }
}
export function refundExecutionError(error: unknown) {
  const messages: Readonly<Record<string, string>> = {
    VERSION_CONFLICT: "详情已变化，请重新读取并核对",
    RESPONSE_MISMATCH: "退款响应关联不一致，已停止处理",
    CONFIRM_MISMATCH: "金额或原交易信息已变化，请重新核对",
    STATE_NOT_ALLOWED: "当前状态不允许此操作，请重新读取",
    PERMISSION_DENIED: "当前权限不能执行此退款",
    STEP_UP_REQUIRED: "请完成再次验证后重试",
    REFUND_EXECUTOR_CONFLICT: "执行人不能是审批人，请另一位同事执行",
    RED_INVOICE_REQUIRED: "请先完成红字发票，再执行退款",
    REFUND_TXN_OPEN: "已有未完成或成功的退款交易，请重新读取",
    REFUND_EXCEEDS_REFUNDABLE: "退款金额超过当前可退余额",
    REFUND_ROUTE_NOT_ALLOWED: "当前退款不能走所选渠道",
    REFUND_NOT_ACCEPTED_UNCONFIRMED: "尚未确认微信未受理，请核对真实渠道状态",
    PAYEE_NAME_MISMATCH: "收款户名须与购买主体一致",
    BANK_SERIAL_DUPLICATE: "银行流水号已被使用，请核对原流水",
    FILE_NOT_USABLE: "回单尚未入库、归属不符或不可使用",
    VALIDATION_FAILED: "请核对转账日期、流水、收款信息与回单",
    PROVIDER_UNAVAILABLE: "渠道结果尚未确认，请保留原意图重试",
    UPSTREAM_TIMEOUT: "渠道请求结果未知，请保留原意图重试",
    IDEMPOTENCY_IN_PROGRESS: "同一操作仍在处理中，请稍后用原意图重试",
  };
  if (!(error instanceof RefundExecutionFailure)) return "请求结果尚未确认，请保留原内容重试";
  const extra = [
    error.details.refundableFen === undefined
      ? ""
      : `当前可退 ${moneyText(error.details.refundableFen)}`,
    error.details.serialNormalized ? `服务端标准流水 ${error.details.serialNormalized}` : "",
  ].filter(Boolean);
  return `${messages[error.symbol] ?? "请求结果尚未确认，请保留原内容重试"}${extra.length ? `（${extra.join("；")}）` : ""}${error.tail ? `（请求编号 ${error.tail}）` : ""}`;
}
export const refundExecutionNeedsReload = (error: unknown) =>
  error instanceof RefundExecutionFailure &&
  (error.status === 409 ||
    ["RESPONSE_MISMATCH", "REFUND_EXECUTOR_CONFLICT"].includes(error.symbol));
export function createRefundExecutionApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    async write(
      row: RefundDetail,
      command: RefundExecutionCommand,
      key: string,
      signal: AbortSignal,
    ) {
      if (row.source === "staging_probe" || row.approval.kind !== "plan_refund")
        throw new RefundExecutionFailure("PERMISSION_DENIED");
      const shared = {
        params: { path: { refundRequestId: row.refundRequestId } },
        headers: { "Idempotency-Key": key },
        signal,
      };
      const response =
        command.action === "execute"
          ? await client.POST("/api/v1/admin/refund-requests/{refundRequestId}/execute", {
              ...shared,
              body: command.body,
            })
          : command.action === "retry"
            ? await client.POST("/api/v1/admin/refund-requests/{refundRequestId}/retry", {
                ...shared,
                body: command.body,
              })
            : command.action === "confirm-not-accepted"
              ? await client.POST(
                  "/api/v1/admin/refund-requests/{refundRequestId}/confirm-not-accepted",
                  { ...shared, body: command.body },
                )
              : await client.POST(
                  "/api/v1/admin/refund-requests/{refundRequestId}/record-offline",
                  { ...shared, body: command.body },
                );
      if (!response.data) {
        const failed: { error?: unknown; response: Response } = response;
        const failure = await readFailure(
          failed.error === undefined
            ? failed.response
            : new Response(JSON.stringify(failed.error), {
                status: failed.response.status,
                headers: failed.response.headers,
              }),
        );
        const raw = failure.body?.details,
          details = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        throw new RefundExecutionFailure(
          failure.symbol,
          failure.status,
          requestIdTail(failure.requestId),
          {
            ...(failure.symbol === "REFUND_EXCEEDS_REFUNDABLE" &&
            Number.isSafeInteger(details.refundableFen) &&
            Number(details.refundableFen) >= 0
              ? { refundableFen: Number(details.refundableFen) }
              : {}),
            ...(failure.symbol === "BANK_SERIAL_DUPLICATE" &&
            typeof details.serialNormalized === "string" &&
            details.serialNormalized.length <= 64
              ? { serialNormalized: details.serialNormalized }
              : {}),
          },
        );
      }
      const current = RefundRequestDetailSchema.parse(response.data.data);
      if (
        current.refundRequestId !== row.refundRequestId ||
        current.approval.approvalId !== row.approval.approvalId ||
        current.approval.kind !== "plan_refund"
      )
        throw new RefundExecutionFailure("RESPONSE_MISMATCH");
      return current;
    },
  };
}
export type RefundExecutionApi = ReturnType<typeof createRefundExecutionApi>;
