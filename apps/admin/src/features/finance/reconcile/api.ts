import {
  A07_ERROR_DETAILS,
  PaymentExceptionCreateBodySchema,
  PaymentExceptionDetailSchema,
  PaymentExceptionPageSchema,
  PaymentExceptionResolveBodySchema,
  PaymentExceptionResolveResultSchema,
  ReconDayRowSchema,
  ReconMonthSchema,
  ReconciliationRerunBodySchema,
} from "@liyoxi/contract";
import type { PaymentExceptionCreateBody, PaymentExceptionResolveBody } from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure, requestIdTail } from "../../../lib/api-errors";
import type { ExceptionDetail, RerunTarget } from "./types";

export class ReconFailure extends Error {
  constructor(
    readonly symbol: string,
    readonly status = 0,
    readonly tail: string | null = null,
    readonly conflicts: ReturnType<
      typeof A07_ERROR_DETAILS.BANK_SERIAL_DUPLICATE.parse
    >["conflicts"] = [],
  ) {
    super(symbol);
  }
}
export function reconError(error: unknown) {
  const labels: Readonly<Record<string, string>> = {
    PERMISSION_DENIED: "当前权限无法读取或处理对账",
    NOT_FOUND: "记录不存在或已不可见",
    VERSION_CONFLICT: "差异版本已变化，请重新核对",
    CONFIRM_MISMATCH: "单号、金额或账单日已变化，请重新核对",
    PRECONDITION_CHANGED: "处理条件已变化，请重新核对",
    STATE_NOT_ALLOWED: "当前记录不可进行此操作",
    RESOLUTION_NOT_ALLOWED: "当前差异不能使用所选处理方式，请重新读取",
    CHANNEL_RECHECK_FAILED: "渠道回查未确认匹配的成功结果，未完成处理",
    PROVIDER_UNAVAILABLE: "渠道暂不可查询，请稍后用原意图重试",
    UPSTREAM_TIMEOUT: "渠道结果尚未确认，请稍后用原意图重试",
    LINK_ORDER_INVALID: "所选付款单不符合关联条件，请重新核对",
    REFUND_REQUEST_EXISTS: "已有退款申请，请查看现有申请",
    REFUND_EXCEEDS_REFUNDABLE: "当前可退余额不足，请重新核对",
    BANK_SERIAL_DUPLICATE: "银行流水号已使用，请核对冲突记录",
    PAYEE_NAME_MISMATCH: "收款户名与原付款人不一致",
    FILE_NOT_USABLE: "凭证尚不可用，请核对上传结果和归属",
    VALIDATION_FAILED: "请核对必填内容、整数金额与日期",
    STEP_UP_REQUIRED: "请完成再次验证后重试",
    IDEMPOTENCY_IN_PROGRESS: "同一操作仍在处理中，请稍后用原意图重试",
    RESPONSE_MISMATCH: "响应与当前记录不一致，已停止处理，请重新读取",
  };
  return `${labels[error instanceof ReconFailure ? error.symbol : "UNKNOWN"] ?? "请求未确认成功，请用原意图重试"}${error instanceof ReconFailure && error.tail ? `（请求编号 ${error.tail}）` : ""}`;
}
export const reconConflict = (error: unknown) =>
  error instanceof ReconFailure && error.status === 409;
async function result<T>(res: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (res.data) return res.data.data;
  const response =
    res.error === undefined
      ? res.response
      : new Response(JSON.stringify(res.error), {
          status: res.response.status,
          headers: res.response.headers,
        });
  const failure = await readFailure(response);
  const parsed =
    failure.symbol === "BANK_SERIAL_DUPLICATE"
      ? A07_ERROR_DETAILS.BANK_SERIAL_DUPLICATE.safeParse(failure.body?.details)
      : undefined;
  throw new ReconFailure(
    failure.symbol,
    failure.status,
    requestIdTail(failure.requestId),
    parsed?.success ? parsed.data.conflicts : [],
  );
}
type ExceptionQuery = NonNullable<operations["admin.paymentException.list"]["parameters"]["query"]>;
function verify<T extends ExceptionDetail>(value: T, id: string): T {
  if (value.paymentExceptionId !== id) throw new ReconFailure("RESPONSE_MISMATCH");
  return value;
}
export function createReconcileApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    async month(month: string, signal: AbortSignal) {
      const value = ReconMonthSchema.parse(
        await result(
          await client.GET("/api/v1/admin/reconciliations", {
            params: { query: { month } },
            signal,
          }),
        ),
      );
      if (value.month !== month || value.items.some((row) => !row.billDate.startsWith(`${month}-`)))
        throw new ReconFailure("RESPONSE_MISMATCH");
      return value;
    },
    async list(query: ExceptionQuery, signal: AbortSignal) {
      return PaymentExceptionPageSchema.parse(
        await result(
          await client.GET("/api/v1/admin/payment-exceptions", {
            params: { query },
            signal,
            querySerializer: { array: { style: "form", explode: false } },
          }),
        ),
      );
    },
    async detail(id: string, signal: AbortSignal) {
      return verify(
        PaymentExceptionDetailSchema.parse(
          await result(
            await client.GET("/api/v1/admin/payment-exceptions/{paymentExceptionId}", {
              params: { path: { paymentExceptionId: id } },
              signal,
            }),
          ),
        ),
        id,
      );
    },
    async rerun(target: RerunTarget, key: string, signal: AbortSignal) {
      const value = ReconDayRowSchema.parse(
        await result(
          await client.POST("/api/v1/admin/reconciliations/{reconciliationId}/rerun", {
            params: { path: { reconciliationId: target.reconciliationId } },
            body: ReconciliationRerunBodySchema.parse({ confirm: { billDate: target.billDate } }),
            headers: { "Idempotency-Key": key },
            signal,
          }),
        ),
      );
      if (value.reconciliationId !== target.reconciliationId || value.billDate !== target.billDate)
        throw new ReconFailure("RESPONSE_MISMATCH");
      return value;
    },
    async create(body: PaymentExceptionCreateBody, key: string, signal: AbortSignal) {
      return PaymentExceptionDetailSchema.parse(
        await result(
          await client.POST("/api/v1/admin/payment-exceptions", {
            body: PaymentExceptionCreateBodySchema.parse(body),
            headers: { "Idempotency-Key": key },
            signal,
          }),
        ),
      );
    },
    async resolve(
      value: ExceptionDetail,
      body: PaymentExceptionResolveBody,
      key: string,
      signal: AbortSignal,
    ) {
      return verify(
        PaymentExceptionResolveResultSchema.parse(
          await result(
            await client.POST("/api/v1/admin/payment-exceptions/{paymentExceptionId}/resolve", {
              params: { path: { paymentExceptionId: value.paymentExceptionId } },
              body: PaymentExceptionResolveBodySchema.parse(body),
              headers: { "Idempotency-Key": key },
              signal,
            }),
          ),
        ),
        value.paymentExceptionId,
      );
    },
    async banks(signal: AbortSignal) {
      return result(
        await client.GET("/api/v1/admin/dict-items", {
          params: { query: { typeKey: "bank" } },
          signal,
        }),
      );
    },
  };
}
export type ReconcileApi = ReturnType<typeof createReconcileApi>;
