import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure, type ApiFailure } from "../../../lib/api-errors";
export type Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export class ReceiptFailure extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}
async function unwrap<T>(result: { data?: { data: T }; response: Response }): Promise<T> {
  if (result.data) return result.data.data;
  throw new ReceiptFailure(await readFailure(result.response));
}
export function createReceiptsApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    list: (tab: "pending" | "processed_today", q?: string) =>
      client
        .GET("/api/v1/admin/transfer-proofs", {
          params: { query: { tab, q, page: 1, pageSize: 100 } },
        })
        .then(unwrap),
    summary: (q?: string) =>
      client
        .GET("/api/v1/admin/transfer-proofs/summary", { params: { query: { q } } })
        .then(unwrap),
    detail: (transferProofId: string) =>
      client
        .GET("/api/v1/admin/transfer-proofs/{transferProofId}", {
          params: { path: { transferProofId } },
        })
        .then(unwrap),
    order: (paymentOrderId: string) =>
      client
        .GET("/api/v1/admin/payment-orders/{paymentOrderId}", {
          params: { path: { paymentOrderId } },
        })
        .then(unwrap),
    confirm: (transferProofId: string, body: Body<"admin.transferProof.confirm">, key: string) =>
      client
        .POST("/api/v1/admin/transfer-proofs/{transferProofId}/confirm", {
          params: { path: { transferProofId } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
    reject: (transferProofId: string, body: Body<"admin.transferProof.reject">, key: string) =>
      client
        .POST("/api/v1/admin/transfer-proofs/{transferProofId}/reject", {
          params: { path: { transferProofId } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
    dictionary: (typeKey: string, scene?: string) =>
      client
        .GET("/api/v1/admin/dict-items", { params: { query: { typeKey, scene } } })
        .then(unwrap),
    image: (fileId: string) =>
      client
        .POST("/api/v1/admin/files/{fileId}/download-urls", {
          params: { path: { fileId } },
          body: { disposition: "inline", purpose: "核对转账凭证" },
        })
        .then(unwrap),
  };
}
export type ReceiptsApi = ReturnType<typeof createReceiptsApi>;
export type ReceiptRow = Awaited<ReturnType<ReceiptsApi["list"]>>["items"][number];
export type ReceiptDetail = Awaited<ReturnType<ReceiptsApi["detail"]>>;
