import {
  PointAccountPageSchema,
  PointAccountSummarySchema,
  PointAccountDetailSchema,
  AccountLedgerPageSchema,
  PointAdjustmentQuoteSchema,
  PointAdjustmentRequestDetailSchema,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { billingResult } from "../plans/api";
import type { Body } from "../plans/model";
export function createAccountsApi(services: Pick<AppServices, "api">) {
  const c = services.api.client;
  return {
    list: (
      query: operations["admin.pointAccount.list"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      c
        .GET("/api/v1/admin/point-accounts", { params: { query }, signal })
        .then(billingResult)
        .then((v) => PointAccountPageSchema.parse(v)),
    summary: (
      query: operations["admin.pointAccount.summary"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      c
        .GET("/api/v1/admin/point-accounts/summary", { params: { query }, signal })
        .then(billingResult)
        .then((v) => PointAccountSummarySchema.parse(v)),
    detail: async (pointAccountId: string, signal?: AbortSignal) => {
      const row = PointAccountDetailSchema.parse(
        await c
          .GET("/api/v1/admin/point-accounts/{pointAccountId}", {
            params: { path: { pointAccountId } },
            signal,
          })
          .then(billingResult),
      );
      if (row.pointAccountId !== pointAccountId) throw new Error("账户归属已变化，请重新读取");
      return row;
    },
    ledger: (
      pointAccountId: string,
      query: operations["admin.pointAccount.pointLedgerEntry.list"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      c
        .GET("/api/v1/admin/point-accounts/{pointAccountId}/point-ledger-entries", {
          params: { path: { pointAccountId }, query },
          signal,
        })
        .then(billingResult)
        .then((v) => AccountLedgerPageSchema.parse(v)),
    quote: (
      pointAccountId: string,
      body: Body<"admin.pointAccount.adjustmentQuote">,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/point-accounts/{pointAccountId}/adjustment-quote", {
          params: { path: { pointAccountId } },
          body,
          signal,
        })
        .then(billingResult)
        .then((v) => PointAdjustmentQuoteSchema.parse(v)),
    create: (body: Body<"admin.pointAdjustmentRequest.create">, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/point-adjustment-requests", {
          body,
          signal,
          headers: { "Idempotency-Key": key },
        })
        .then(billingResult)
        .then((v) => PointAdjustmentRequestDetailSchema.parse(v)),
  };
}
export type AccountsApi = ReturnType<typeof createAccountsApi>;
export type AccountRow = Awaited<ReturnType<AccountsApi["list"]>>["items"][number];
export type AccountDetail = Awaited<ReturnType<AccountsApi["detail"]>>;
