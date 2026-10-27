import {
  AdminPaymentOrderPageSchema,
  AdminPaymentOrderSummarySchema,
  PaymentOrderAdminDetailSchema,
  TransferProofDetailSchema,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { billingResult } from "../../billing/plans/api";
import type { Body } from "../../billing/plans/model";
export function createPaymentOrdersApi(services: Pick<AppServices, "api">) {
  const c = services.api.client;
  return {
    list: (
      query: operations["admin.paymentOrder.list"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      c
        .GET("/api/v1/admin/payment-orders", { params: { query }, signal })
        .then(billingResult)
        .then((v) => AdminPaymentOrderPageSchema.parse(v)),
    summary: (
      query: operations["admin.paymentOrder.summary"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      c
        .GET("/api/v1/admin/payment-orders/summary", { params: { query }, signal })
        .then(billingResult)
        .then((v) => AdminPaymentOrderSummarySchema.parse(v)),
    detail: async (paymentOrderId: string, signal?: AbortSignal) => {
      const row = PaymentOrderAdminDetailSchema.parse(
        await c
          .GET("/api/v1/admin/payment-orders/{paymentOrderId}", {
            params: { path: { paymentOrderId } },
            signal,
          })
          .then(billingResult),
      );
      if (row.paymentOrderId !== paymentOrderId) throw new Error("付款单归属已变化，请重新读取");
      return row;
    },
    create: (body: Body<"admin.paymentOrder.create">, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/payment-orders", { body, signal, headers: { "Idempotency-Key": key } })
        .then(billingResult)
        .then((v) => PaymentOrderAdminDetailSchema.parse(v)),
    proof: (
      paymentOrderId: string,
      body: Body<"admin.paymentOrder.transferProof.create">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/payment-orders/{paymentOrderId}/transfer-proofs", {
          params: { path: { paymentOrderId } },
          body,
          signal,
          headers: { "Idempotency-Key": key },
        })
        .then(billingResult)
        .then((v) => TransferProofDetailSchema.parse(v)),
  };
}
export type PaymentOrdersApi = ReturnType<typeof createPaymentOrdersApi>;
export type PaymentRow = Awaited<ReturnType<PaymentOrdersApi["list"]>>["items"][number];
export type PaymentDetail = Awaited<ReturnType<PaymentOrdersApi["detail"]>>;
/** create/get无submit-proof action，必须另取真正同主体、同单的列表action；绝不以状态猜测。 */
export async function readProofPermission(
  api: Pick<PaymentOrdersApi, "list">,
  order: Pick<PaymentDetail, "paymentOrderId" | "orderNo" | "entity">,
  signal?: AbortSignal,
) {
  const page = await api.list(
    {
      no: order.orderNo,
      entityId: order.entity.entityId,
      page: 1,
      pageSize: 10,
      tab: "all",
      sort: "-createdAt",
    },
    signal,
  );
  const row = page.items.find(
    (r) =>
      r.paymentOrderId === order.paymentOrderId &&
      r.orderNo === order.orderNo &&
      r.entity.entityId === order.entity.entityId,
  );
  return !!row?.actions.includes("submit-proof");
}
