import {
  CashRefundQuoteSchema,
  DictItemListSchema,
  PaymentOrderAdminDetailSchema,
  RefundCreateBodySchema,
  RefundQuoteBodySchema,
  RefundRequestDetailSchema,
} from "@liyoxi/contract";
import type { RefundCreateBody } from "@liyoxi/contract";
import type { AppServices } from "../../../app/services";
import { readFailure, requestIdTail } from "../../../lib/api-errors";
import type { RefundRule, RefundSnapshot, RefundTarget } from "./request-model";
export class RefundRequestFailure extends Error {
  constructor(
    readonly symbol: string,
    readonly status = 0,
    readonly tail: string | null = null,
  ) {
    super(symbol);
  }
}
export function refundRequestError(error: unknown) {
  const labels: Readonly<Record<string, string>> = {
    PERMISSION_DENIED: "当前权限无法申请退款",
    NOT_FOUND: "付款单或申请不存在或不可见",
    PRECONDITION_CHANGED: "付款、规则或金额已变化，请重新试算并核对",
    CONFIRM_MISMATCH: "确认内容已变化，请重新试算",
    REFUND_REQUEST_EXISTS: "已有退款申请，请读取当前申请",
    PLAN_REFUND_NOT_ELIGIBLE: "当前付款不符合所选规则",
    REFUND_NOT_SUPPORTED: "当前付款不支持现金退款",
    REFUND_EXCEEDS_REFUNDABLE: "当前可退余额已变化，请重新试算",
    DICT_ITEM_DISABLED: "退款原因已停用，请重新选择",
    VALIDATION_FAILED: "请核对退款规则、原因与说明",
    IDEMPOTENCY_IN_PROGRESS: "同一申请仍在处理中，请保留原内容重试",
    STEP_UP_REQUIRED: "请完成再次验证后重试",
    RESPONSE_MISMATCH: "响应与当前付款单不一致，已停止申请",
  };
  return `${labels[error instanceof RefundRequestFailure ? error.symbol : "UNKNOWN"] ?? "结果尚未确认，请保留原内容重试"}${error instanceof RefundRequestFailure && error.tail ? `（请求编号 ${error.tail}）` : ""}`;
}
async function result<T>(value: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (value.data) return value.data.data;
  const failure = await readFailure(
    value.error === undefined
      ? value.response
      : new Response(JSON.stringify(value.error), {
          status: value.response.status,
          headers: value.response.headers,
        }),
  );
  throw new RefundRequestFailure(failure.symbol, failure.status, requestIdTail(failure.requestId));
}
export function createRefundRequestApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  const verifyRequest = (value: unknown, target: RefundTarget, id?: string) => {
    const row = RefundRequestDetailSchema.parse(value);
    if (
      (id && row.refundRequestId !== id) ||
      row.paymentOrder?.paymentOrderId !== target.paymentOrderId ||
      row.paymentOrder.orderNo !== target.orderNo ||
      row.entity?.entityId !== target.entityId ||
      row.paymentTxn.paymentTransactionId !== target.paymentTransactionId ||
      row.approval.kind !== "plan_refund"
    )
      throw new RefundRequestFailure("RESPONSE_MISMATCH");
    return row;
  };
  return {
    async snapshot(
      target: RefundTarget,
      rule: RefundRule | undefined,
      signal: AbortSignal,
    ): Promise<RefundSnapshot> {
      // actual refundQuote为无幂等POST只读试算；付款单身份另由真实GET核验。
      const [order, quote] = await Promise.all([
        client
          .GET("/api/v1/admin/payment-orders/{paymentOrderId}", {
            params: { path: { paymentOrderId: target.paymentOrderId } },
            signal,
          })
          .then(result)
          .then((value) => PaymentOrderAdminDetailSchema.parse(value)),
        client
          .POST("/api/v1/admin/payment-orders/{paymentOrderId}/refund-quote", {
            params: { path: { paymentOrderId: target.paymentOrderId } },
            body: RefundQuoteBodySchema.parse(rule ? { ruleCode: rule } : {}),
            signal,
          })
          .then(result)
          .then((value) => CashRefundQuoteSchema.parse(value)),
      ]);
      if (
        order.paymentOrderId !== target.paymentOrderId ||
        order.orderNo !== target.orderNo ||
        order.entity.entityId !== target.entityId ||
        (quote.paymentTxn && quote.paymentTxn.paymentTransactionId !== target.paymentTransactionId)
      )
        throw new RefundRequestFailure("RESPONSE_MISMATCH");
      return { order, quote };
    },
    async reasons(signal: AbortSignal) {
      return DictItemListSchema.parse(
        await result(
          await client.GET("/api/v1/admin/dict-items", {
            params: { query: { typeKey: "refund_reason" } },
            signal,
          }),
        ),
      );
    },
    async create(target: RefundTarget, body: RefundCreateBody, key: string, signal: AbortSignal) {
      return verifyRequest(
        await result(
          await client.POST("/api/v1/admin/payment-orders/{paymentOrderId}/refund-requests", {
            params: { path: { paymentOrderId: target.paymentOrderId } },
            body: RefundCreateBodySchema.parse(body),
            headers: { "Idempotency-Key": key },
            signal,
          }),
        ),
        target,
      );
    },
    async get(target: RefundTarget, refundRequestId: string, signal: AbortSignal) {
      return verifyRequest(
        await result(
          await client.GET("/api/v1/admin/refund-requests/{refundRequestId}", {
            params: { path: { refundRequestId } },
            signal,
          }),
        ),
        target,
        refundRequestId,
      );
    },
  };
}
export type RefundRequestApi = ReturnType<typeof createRefundRequestApi>;
