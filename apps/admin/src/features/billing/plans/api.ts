import {
  PlanAdminListSchema,
  PlanAdminColumnSchema,
  PlanSummarySchema,
  PlanRevisionPageSchema,
  PlanRevisionViewSchema,
  PlanAdminQuoteSchema,
} from "@liyoxi/contract";
import type { AppServices } from "../../../app/services";
import { readFailure, type ApiFailure } from "../../../lib/api-errors";
import type { Body } from "./model";
export class BillingFailure extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}
export async function billingResult<T>(result: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (result.data) return result.data.data;
  const response =
    result.error === undefined
      ? result.response
      : new Response(JSON.stringify(result.error), {
          status: result.response.status,
          headers: result.response.headers,
        });
  throw new BillingFailure(await readFailure(response));
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
export function billingError(error: unknown) {
  if (record(error) && Array.isArray(error.issues)) {
    const messages = error.issues
      .filter(record)
      .flatMap((issue) =>
        typeof issue.message === "string"
          ? [`${Array.isArray(issue.path) ? issue.path.join(".") : "输入"}：${issue.message}`]
          : [],
      );
    if (messages.length) return messages.join("；");
  }
  if (!(error instanceof BillingFailure))
    return error instanceof Error ? error.message : "没有保存成功，请重试";
  const body = error.failure.body,
    details = body?.details;
  const fields =
    body?.fieldErrors ??
    (record(details) && Array.isArray(details.fieldErrors) ? details.fieldErrors : []);
  const messages = fields
    .filter(record)
    .flatMap((v) =>
      typeof v.path === "string" && typeof v.message === "string"
        ? [`${v.path}：${v.message}`]
        : [],
    );
  const earliest =
    record(details) && typeof details.earliestEffectiveDate === "string"
      ? `；最早生效日 ${details.earliestEffectiveDate}`
      : "";
  return `${messages.length ? messages.join("；") : error.message}${earliest}`;
}
export function billingConflict(error: unknown) {
  return (
    error instanceof BillingFailure &&
    [
      "VERSION_CONFLICT",
      "CONFIRM_MISMATCH",
      "QUOTE_CHANGED",
      "REVISION_ALREADY_EFFECTIVE",
      "REVISION_PENDING_EXISTS",
    ].includes(error.failure.symbol)
  );
}
export function createPlansApi(services: Pick<AppServices, "api">) {
  const c = services.api.client;
  return {
    list: (includeDelisted: boolean, signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/plans", {
          params: { query: { includeDelisted: includeDelisted ? "true" : "false" } },
          signal,
        })
        .then(billingResult)
        .then((v) => PlanAdminListSchema.parse(v)),
    summary: (signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/plans/summary", { signal })
        .then(billingResult)
        .then((v) => PlanSummarySchema.parse(v)),
    revisions: (planId: string, page: number, pageSize: number, signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/plan-revisions", {
          params: { query: { planId, page, pageSize } },
          signal,
        })
        .then(billingResult)
        .then((v) => PlanRevisionPageSchema.parse(v)),
    create: (body: Body<"admin.plan.create">, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/plans", { body, headers: { "Idempotency-Key": key }, signal })
        .then(billingResult)
        .then((v) => PlanAdminColumnSchema.parse(v)),
    rename: (planId: string, body: Body<"admin.plan.update">, key: string, signal: AbortSignal) =>
      c
        .PATCH("/api/v1/admin/plans/{planId}", {
          params: { path: { planId } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => PlanAdminColumnSchema.parse(v)),
    revision: (
      planId: string,
      body: Body<"admin.plan.planRevision.create">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/plans/{planId}/plan-revisions", {
          params: { path: { planId } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => PlanRevisionViewSchema.parse(v)),
    shelve: (planId: string, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/plans/{planId}/shelve", {
          params: { path: { planId } },
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => PlanAdminColumnSchema.parse(v)),
    delist: (planId: string, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/plans/{planId}/delist", {
          params: { path: { planId } },
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => PlanAdminColumnSchema.parse(v)),
    withdraw: (
      planRevisionId: string,
      body: Body<"admin.planRevision.withdraw">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/plan-revisions/{planRevisionId}/withdraw", {
          params: { path: { planRevisionId } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => PlanRevisionViewSchema.parse(v)),
    quote: (body: Body<"admin.plan.quote">, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/plans/quote", { body, signal })
        .then(billingResult)
        .then((v) => PlanAdminQuoteSchema.parse(v)),
  };
}
export type PlansApi = ReturnType<typeof createPlansApi>;
export type PlanColumn = Awaited<ReturnType<PlansApi["list"]>>["items"][number];
export type PlanRevision = Awaited<ReturnType<PlansApi["revisions"]>>["items"][number];
