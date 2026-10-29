import {
  RefundRequestDetailSchema,
  RefundRequestPageSchema,
  RefundSummarySchema,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { financeResult } from "../payments/api";

export function createRefundsApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    list: (
      query: operations["admin.refundRequest.list"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      client
        .GET("/api/v1/admin/refund-requests", { params: { query }, signal })
        .then(financeResult)
        .then((data) => RefundRequestPageSchema.parse(data)),
    summary: (
      query: operations["admin.refundRequest.summary"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      client
        .GET("/api/v1/admin/refund-requests/summary", { params: { query }, signal })
        .then(financeResult)
        .then((data) => RefundSummarySchema.parse(data)),
    detail: async (refundRequestId: string, signal?: AbortSignal) => {
      const data = RefundRequestDetailSchema.parse(
        await client
          .GET("/api/v1/admin/refund-requests/{refundRequestId}", {
            params: { path: { refundRequestId } },
            signal,
          })
          .then(financeResult),
      );
      if (data.refundRequestId !== refundRequestId) throw new Error("退款申请已变化，请重新读取");
      return data;
    },
  };
}
export type RefundsApi = ReturnType<typeof createRefundsApi>;
export type RefundRow = Awaited<ReturnType<RefundsApi["list"]>>["items"][number];
export type RefundDetail = Awaited<ReturnType<RefundsApi["detail"]>>;
