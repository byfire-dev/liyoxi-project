import {
  adminPage,
  ApprovalCountsSchema,
  ApprovalDetailSchema,
  ApprovalItemSchema,
  PointAdjustmentRequestDetailSchema,
  TermExtensionRequestDetailSchema,
  PointAdjustmentApproveBodySchema,
  TermExtensionApproveBodySchema,
  BillingAdjustmentRejectBodySchema,
  BillingAdjustmentWithdrawBodySchema,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure, requestIdTail } from "../../../lib/api-errors";
import type { AdjustmentCase, AdjustmentKind, Decision } from "./types";

export type { AdjustmentCase } from "./types";
const pageSchema = adminPage(ApprovalItemSchema);
export class AdjustmentFailure extends Error {
  constructor(
    readonly symbol: string,
    readonly status = 0,
    readonly tail: string | null = null,
  ) {
    super(symbol);
  }
}
export function adjustmentError(error: unknown) {
  const symbol = error instanceof AdjustmentFailure ? error.symbol : "UNKNOWN",
    labels: Readonly<Record<string, string>> = {
      PERMISSION_DENIED: "当前权限无法读取或处理此申请",
      NOT_FOUND: "申请不存在或已不可见",
      VERSION_CONFLICT: "申请版本已变化，请重新核对",
      CONFIRM_MISMATCH: "确认内容已变化，请重新核对",
      PRECONDITION_CHANGED: "执行条件已变化，请重新核对",
      STATE_NOT_ALLOWED: "申请已被处理，请重新核对",
      VALIDATION_FAILED: "请核对填写的说明与确认信息",
      STEP_UP_REQUIRED: "请完成再次验证后重试",
      IDEMPOTENCY_IN_PROGRESS: "同一操作仍在处理中，请稍后用原意图重试",
      RESPONSE_MISMATCH: "申请详情关联不一致，已停止处理，请重新读取",
    },
    message = labels[symbol] ?? "请求未确认成功，请重试；写操作将复用原意图";
  return `${message}${error instanceof AdjustmentFailure && error.tail ? `（请求编号 ${error.tail}）` : ""}`;
}
export const needsReconfirm = (error: unknown) =>
  error instanceof AdjustmentFailure &&
  (error.status === 409 ||
    ["VERSION_CONFLICT", "CONFIRM_MISMATCH", "PRECONDITION_CHANGED", "STATE_NOT_ALLOWED"].includes(
      error.symbol,
    ));
async function result<T>(response: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (response.data) return response.data.data;
  const source =
      response.error === undefined
        ? response.response
        : new Response(JSON.stringify(response.error), {
            status: response.response.status,
            headers: response.response.headers,
          }),
    failure = await readFailure(source);
  throw new AdjustmentFailure(failure.symbol, failure.status, requestIdTail(failure.requestId));
}
function verify(value: AdjustmentCase, approvalId: string, id: string) {
  if (
    value.row.approval.approvalId !== approvalId ||
    value.row.approval.kind !== value.kind ||
    (value.kind === "points_adjust"
      ? value.row.pointAdjustmentRequestId
      : value.row.termExtensionRequestId) !== id
  )
    throw new AdjustmentFailure("RESPONSE_MISMATCH");
  return value;
}
export function createAdjustmentApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    async list(
      query: operations["admin.approval.list"]["parameters"]["query"],
      signal: AbortSignal,
    ) {
      const page = pageSchema.parse(
        await result(await client.GET("/api/v1/admin/approvals", { params: { query }, signal })),
      );
      if (page.items.some((row) => !["points_adjust", "subscription_extend"].includes(row.kind)))
        throw new AdjustmentFailure("RESPONSE_MISMATCH");
      return page;
    },
    async summary(
      query: operations["admin.approval.summary"]["parameters"]["query"],
      signal: AbortSignal,
    ) {
      return ApprovalCountsSchema.parse(
        await result(
          await client.GET("/api/v1/admin/approvals/summary", { params: { query }, signal }),
        ),
      );
    },
    async get(
      approvalId: string,
      allowed: readonly AdjustmentKind[],
      signal: AbortSignal,
    ): Promise<AdjustmentCase> {
      const detail = ApprovalDetailSchema.parse(
        await result(
          await client.GET("/api/v1/admin/approvals/{approvalId}", {
            params: { path: { approvalId } },
            signal,
          }),
        ),
      );
      if (detail.approvalId !== approvalId) throw new AdjustmentFailure("RESPONSE_MISMATCH");
      if (!allowed.some((kind) => kind === detail.kind))
        throw new AdjustmentFailure("PERMISSION_DENIED");
      const id = detail.domain.id;
      if (
        detail.kind === "points_adjust" &&
        detail.domain.type === "point_adjustment_request" &&
        detail.operations.get === "admin.pointAdjustmentRequest.get"
      ) {
        const row = PointAdjustmentRequestDetailSchema.parse(
          await result(
            await client.GET("/api/v1/admin/point-adjustment-requests/{pointAdjustmentRequestId}", {
              params: { path: { pointAdjustmentRequestId: id } },
              signal,
            }),
          ),
        );
        return verify({ kind: "points_adjust", row }, approvalId, id);
      }
      if (
        detail.kind === "subscription_extend" &&
        detail.domain.type === "term_extension_request" &&
        detail.operations.get === "admin.termExtensionRequest.get"
      ) {
        const row = TermExtensionRequestDetailSchema.parse(
          await result(
            await client.GET("/api/v1/admin/term-extension-requests/{termExtensionRequestId}", {
              params: { path: { termExtensionRequestId: id } },
              signal,
            }),
          ),
        );
        return verify({ kind: "subscription_extend", row }, approvalId, id);
      }
      throw new AdjustmentFailure("RESPONSE_MISMATCH");
    },
    async decide(
      value: AdjustmentCase,
      action: Decision,
      note: string,
      key: string,
      signal: AbortSignal,
    ): Promise<AdjustmentCase> {
      const shared = { headers: { "Idempotency-Key": key }, signal },
        approvalId = value.row.approval.approvalId;
      if (value.kind === "points_adjust") {
        const id = value.row.pointAdjustmentRequestId,
          params = { path: { pointAdjustmentRequestId: id } };
        const response =
          action === "approve"
            ? await client.POST(
                "/api/v1/admin/point-adjustment-requests/{pointAdjustmentRequestId}/approve",
                {
                  ...shared,
                  params,
                  body: PointAdjustmentApproveBodySchema.parse({
                    lockVersion: value.row.approval.lockVersion,
                    confirm: {
                      requestNo: value.row.requestNo,
                      direction: value.row.direction,
                      adjustPoints: value.row.adjustPoints,
                    },
                    confirmChecks: ["basis_checked"],
                  }),
                },
              )
            : action === "reject"
              ? await client.POST(
                  "/api/v1/admin/point-adjustment-requests/{pointAdjustmentRequestId}/reject",
                  { ...shared, params, body: BillingAdjustmentRejectBodySchema.parse({ note }) },
                )
              : await client.POST(
                  "/api/v1/admin/point-adjustment-requests/{pointAdjustmentRequestId}/withdraw",
                  {
                    ...shared,
                    params,
                    body: BillingAdjustmentWithdrawBodySchema.parse({ note: note || undefined }),
                  },
                );
        return verify(
          {
            kind: value.kind,
            row: PointAdjustmentRequestDetailSchema.parse(await result(response)),
          },
          approvalId,
          id,
        );
      }
      const id = value.row.termExtensionRequestId,
        params = { path: { termExtensionRequestId: id } };
      const response =
        action === "approve"
          ? await client.POST(
              "/api/v1/admin/term-extension-requests/{termExtensionRequestId}/approve",
              {
                ...shared,
                params,
                body: TermExtensionApproveBodySchema.parse({
                  lockVersion: value.row.approval.lockVersion,
                  confirm: { requestNo: value.row.requestNo, days: value.row.days },
                  confirmChecks: ["effect_preview_checked"],
                }),
              },
            )
          : action === "reject"
            ? await client.POST(
                "/api/v1/admin/term-extension-requests/{termExtensionRequestId}/reject",
                { ...shared, params, body: BillingAdjustmentRejectBodySchema.parse({ note }) },
              )
            : await client.POST(
                "/api/v1/admin/term-extension-requests/{termExtensionRequestId}/withdraw",
                {
                  ...shared,
                  params,
                  body: BillingAdjustmentWithdrawBodySchema.parse({ note: note || undefined }),
                },
              );
      return verify(
        { kind: value.kind, row: TermExtensionRequestDetailSchema.parse(await result(response)) },
        approvalId,
        id,
      );
    },
  };
}
export type AdjustmentApi = ReturnType<typeof createAdjustmentApi>;
export type AdjustmentRow = Awaited<ReturnType<AdjustmentApi["list"]>>["items"][number];
