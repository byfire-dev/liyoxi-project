import {
  SubscriptionTermPageSchema,
  SubscriptionTermSummarySchema,
  SubscriptionTermDetailSchema,
  SubscriptionTermReminderSchema,
  ExtensionQuoteSchema,
  TermExtensionRequestDetailSchema,
  DictItemListSchema,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { billingResult } from "../../billing/plans/api";
import type { Body } from "../../billing/plans/model";
export function createRenewalsApi(services: Pick<AppServices, "api">) {
  const c = services.api.client;
  return {
    list: (
      query: operations["admin.subscriptionTerm.list"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      c
        .GET("/api/v1/admin/subscription-terms", { params: { query }, signal })
        .then(billingResult)
        .then((v) => SubscriptionTermPageSchema.parse(v)),
    summary: (
      query: operations["admin.subscriptionTerm.summary"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      c
        .GET("/api/v1/admin/subscription-terms/summary", { params: { query }, signal })
        .then(billingResult)
        .then((v) => SubscriptionTermSummarySchema.parse(v)),
    detail: async (subscriptionTermId: string, signal?: AbortSignal) => {
      const row = SubscriptionTermDetailSchema.parse(
        await c
          .GET("/api/v1/admin/subscription-terms/{subscriptionTermId}", {
            params: { path: { subscriptionTermId } },
            signal,
          })
          .then(billingResult),
      );
      if (row.subscriptionTermId !== subscriptionTermId)
        throw new Error("周期归属已变化，请重新读取");
      return row;
    },
    remind: (subscriptionTermId: string, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/subscription-terms/{subscriptionTermId}/remind", {
          params: { path: { subscriptionTermId } },
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => SubscriptionTermReminderSchema.parse(v)),
    quote: (
      subscriptionTermId: string,
      body: Body<"admin.subscriptionTerm.extensionQuote">,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/subscription-terms/{subscriptionTermId}/extension-quote", {
          params: { path: { subscriptionTermId } },
          body,
          signal,
        })
        .then(billingResult)
        .then((v) => ExtensionQuoteSchema.parse(v)),
    create: (body: Body<"admin.termExtensionRequest.create">, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/term-extension-requests", {
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => TermExtensionRequestDetailSchema.parse(v)),
    reasons: (signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/dict-items", {
          params: { query: { typeKey: "extend_reason", includeDisabled: "false" } },
          signal,
        })
        .then(billingResult)
        .then((v) => DictItemListSchema.parse(v)),
  };
}
export type RenewalsApi = ReturnType<typeof createRenewalsApi>;
export type TermRow = Awaited<ReturnType<RenewalsApi["list"]>>["items"][number];
export type TermDetail = Awaited<ReturnType<RenewalsApi["detail"]>>;
