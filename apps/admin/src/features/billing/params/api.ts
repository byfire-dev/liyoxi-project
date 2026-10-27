import {
  BillingParamListSchema,
  BillingParamViewSchema,
  PricingChangePageSchema,
  PricingChangeRecordSchema,
  PriceTierListSchema,
} from "@liyoxi/contract";
import type { AppServices } from "../../../app/services";
import { billingResult } from "../plans/api";
import type { Body } from "../plans/model";
export function createBillingParamsApi(services: Pick<AppServices, "api">) {
  const c = services.api.client;
  return {
    list: (signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/billing-params", { signal })
        .then(billingResult)
        .then((v) => BillingParamListSchema.parse(v)),
    tiers: (signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/price-tier-revisions", { signal })
        .then(billingResult)
        .then((v) => PriceTierListSchema.parse(v)),
    history: (
      query: {
        page: number;
        pageSize: 10 | 20 | 50;
        kind?: "price_tier" | "billing_param";
        key?: BillingParam["key"];
        createdFrom?: string;
        createdTo?: string;
      },
      signal?: AbortSignal,
    ) =>
      c
        .GET("/api/v1/admin/pricing-changes", { params: { query }, signal })
        .then(billingResult)
        .then((v) => PricingChangePageSchema.parse(v)),
    create: (body: Body<"admin.pricingChange.create">, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/pricing-changes", {
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => PricingChangeRecordSchema.parse(v)),
    withdraw: (
      billingParamId: string,
      body: Body<"admin.billingParam.withdraw">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/billing-params/{billingParamId}/withdraw", {
          params: { path: { billingParamId } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => BillingParamViewSchema.parse(v)),
  };
}
export type BillingParamsApi = ReturnType<typeof createBillingParamsApi>;
export type BillingParam = ReturnType<typeof BillingParamViewSchema.parse>;
