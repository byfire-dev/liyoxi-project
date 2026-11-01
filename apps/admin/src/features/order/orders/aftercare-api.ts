import {
  AdminOrderDetailSchema,
  CancelQuoteSchema,
  CancelRequestDetailSchema,
  DownloadHistorySchema,
  LicenseLetterCorrectBodySchema,
  LicenseLetterListSchema,
  LicenseLetterRerenderBodySchema,
  LicenseLetterVoidBodySchema,
  OrderActivityPageSchema,
  OrderCancelQuoteBodySchema,
  OrderCancelRequestCreateBodySchema,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";
import type { OrderDetail } from "./api";

type Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer T } };
}
  ? T
  : never;
export type CancelInput = Body<"admin.order.cancelQuote">;
export type CancelCreate = Body<"admin.order.cancelRequest.create">;
export type LicenseCommand =
  | {
      kind: "correct";
      letterId: string;
      revisionId: string | null;
      body: Body<"admin.licenseLetter.correct">;
    }
  | {
      kind: "void";
      letterId: string;
      revisionId: string | null;
      body: Body<"admin.licenseLetter.void">;
    }
  | {
      kind: "rerender";
      letterId: string;
      revisionId: string;
      body: Body<"admin.licenseLetterRevision.rerender">;
    };
export class OrderAftercareFailure extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(code);
  }
}
const messages: Readonly<Record<string, string>> = {
  PERMISSION_DENIED: "当前权限不能执行此操作",
  NOT_FOUND: "当前范围内未找到此订单或授权书",
  PRECONDITION_CHANGED: "当前事实已变化，请刷新并重新核对",
  VERSION_CONFLICT: "当前版本已变化，请刷新并重新核对",
  CONFIRM_MISMATCH: "试算积分已变化，请重新试算并确认",
  CANCEL_QUOTE_CHANGED: "取消试算已变化，请重新试算并确认",
  CANCEL_ITEM_NOT_ALLOWED: "当前项目不允许取消，请刷新事实",
  VALIDATION_FAILED: "请核对原因、范围与必填说明",
  STATE_NOT_ALLOWED: "当前状态不允许此操作，请刷新事实",
  FILE_NOT_READY: "当前授权 PDF 尚未就绪",
  RESPONSE_MISMATCH: "返回内容与当前订单不一致，请重新读取",
};
export function definiteAftercareRejection(error: unknown) {
  return (
    error instanceof OrderAftercareFailure &&
    [400, 401, 403, 404, 409].includes(error.status) &&
    [
      "VALIDATION_FAILED",
      "PERMISSION_DENIED",
      "AUTH_REQUIRED",
      "SESSION_INVALID",
      "NOT_FOUND",
      "PRECONDITION_CHANGED",
      "VERSION_CONFLICT",
      "CONFIRM_MISMATCH",
      "CANCEL_QUOTE_CHANGED",
      "CANCEL_ITEM_NOT_ALLOWED",
      "STATE_NOT_ALLOWED",
    ].includes(error.code)
  );
}
export function aftercareError(error: unknown) {
  return error instanceof OrderAftercareFailure
    ? (messages[error.code] ?? "请求未确认成功，请刷新事实后用原意图重试")
    : "请求未确认成功，请刷新事实后用原意图重试";
}
async function result<T>(value: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (value.data) return value.data.data;
  const response =
    value.error === undefined
      ? value.response
      : new Response(JSON.stringify(value.error), {
          status: value.response.status,
          headers: value.response.headers,
        });
  const failure = await readFailure(response);
  throw new OrderAftercareFailure(failure.symbol, failure.status);
}
function active(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("操作已关闭", "AbortError");
}
export function cancelQuoteIdentity(quote: CancelQuote) {
  // quotedAt changes on every read; the actual lines/amount/destination must stay identical.
  const { quotedAt: _quotedAt, ...facts } = quote;
  return JSON.stringify(facts);
}
export function manualDeductReady(quote: CancelQuote, input: CancelInput) {
  // The server flag describes the pricing stage, not whether the operator has filled it in.
  return (
    !quote.needsManualDeduct ||
    (quote.lines.some((line) => line.isManualDeduct) &&
      quote.lines
        .filter((line) => line.isManualDeduct)
        .every((line) =>
          input.manualDeducts?.some(
            (row) =>
              row.orderItemId === line.targetId &&
              row.deductPoints === line.deductPoints &&
              row.deductNote.trim() === line.deductNote?.trim(),
          ),
        ))
  );
}
export function createOrderAftercareApi(services: Pick<AppServices, "api">) {
  const c = services.api.client;
  const get = async (orderId: string, signal: AbortSignal) => {
    active(signal);
    const value = AdminOrderDetailSchema.parse(
      await result(
        await c.GET("/api/v1/admin/orders/{orderId}", {
          params: { path: { orderId } },
          signal,
        }),
      ),
    );
    active(signal);
    if (value.orderId !== orderId) throw new OrderAftercareFailure("RESPONSE_MISMATCH");
    return value;
  };
  const item = async (orderId: string, itemId: string, signal: AbortSignal) => {
    const current = await get(orderId, signal);
    if (!current.items.some((row) => row.orderItemId === itemId))
      throw new OrderAftercareFailure("RESPONSE_MISMATCH");
    return current;
  };
  const quote = async (orderId: string, raw: CancelInput, signal: AbortSignal) => {
    const body = OrderCancelQuoteBodySchema.parse(raw);
    const current = await get(orderId, signal);
    if (body.orderItemIds?.some((id) => !current.items.some((row) => row.orderItemId === id)))
      throw new OrderAftercareFailure("RESPONSE_MISMATCH");
    return CancelQuoteSchema.parse(
      await result(
        await c.POST("/api/v1/admin/orders/{orderId}/cancel-quote", {
          params: { path: { orderId } },
          body,
          signal,
        }),
      ),
    );
  };
  const licenses = async (orderId: string, itemId: string, signal: AbortSignal) => {
    await item(orderId, itemId, signal);
    const value = LicenseLetterListSchema.parse(
      await result(
        await c.GET("/api/v1/admin/order-items/{orderItemId}/license-letters", {
          params: { path: { orderItemId: itemId }, query: { includeVoided: true } },
          signal,
        }),
      ),
    );
    active(signal);
    if (value.items.some((row) => row.orderItemId !== itemId))
      throw new OrderAftercareFailure("RESPONSE_MISMATCH");
    return value;
  };
  return {
    get,
    quote,
    licenses,
    async createCancel(
      orderId: string,
      raw: CancelCreate,
      seen: CancelQuote,
      key: string,
      signal: AbortSignal,
    ) {
      const body = OrderCancelRequestCreateBodySchema.parse(raw);
      const {
        note: _note,
        expect: _expect,
        serviceTicketId: _serviceTicketId,
        ...quoteBody
      } = body;
      const current = await quote(orderId, quoteBody, signal);
      if (
        current.blockers.length ||
        !manualDeductReady(current, quoteBody) ||
        cancelQuoteIdentity(current) !== cancelQuoteIdentity(seen)
      )
        throw new OrderAftercareFailure("PRECONDITION_CHANGED", 409);
      active(signal);
      const receipt = CancelRequestDetailSchema.parse(
        await result(
          await c.POST("/api/v1/admin/orders/{orderId}/cancel-requests", {
            params: { path: { orderId } },
            headers: { "Idempotency-Key": key },
            body,
            signal,
          }),
        ),
      );
      if (receipt.order?.orderId !== orderId) throw new OrderAftercareFailure("RESPONSE_MISMATCH");
    },
    activity: (orderId: string, signal: AbortSignal, cursor?: string) =>
      c
        .GET("/api/v1/admin/orders/{orderId}/activities", {
          params: { path: { orderId }, query: { cursor, limit: 20 } },
          signal,
        })
        .then(result)
        .then((value) => OrderActivityPageSchema.parse(value)),
    async downloads(orderId: string, itemId: string, signal: AbortSignal, page = 1) {
      await item(orderId, itemId, signal);
      return DownloadHistorySchema.parse(
        await result(
          await c.GET("/api/v1/admin/order-items/{orderItemId}/downloads", {
            params: { path: { orderItemId: itemId }, query: { page, pageSize: 20 } },
            signal,
          }),
        ),
      );
    },
    async writeLicense(
      orderId: string,
      itemId: string,
      command: LicenseCommand,
      key: string,
      signal: AbortSignal,
    ) {
      const current = await licenses(orderId, itemId, signal);
      const letter = current.items.find((row) => row.licenseLetterId === command.letterId);
      if (!letter) throw new OrderAftercareFailure("PRECONDITION_CHANGED", 409);
      const common = { headers: { "Idempotency-Key": key }, signal };
      active(signal);
      if (command.kind === "rerender") {
        const revision = letter.revisions.find(
          (row) => row.licenseLetterRevisionId === command.revisionId,
        );
        if (
          letter.status === "voided" ||
          revision?.renderStatus !== "failed" ||
          !revision.actions.includes("rerender")
        )
          throw new OrderAftercareFailure("PRECONDITION_CHANGED", 409);
        await c
          .POST("/api/v1/admin/license-letter-revisions/{licenseLetterRevisionId}/rerender", {
            ...common,
            params: { path: { licenseLetterRevisionId: command.revisionId } },
            body: LicenseLetterRerenderBodySchema.parse(command.body),
          })
          .then(result);
      } else {
        if (
          letter.currentRevision?.licenseLetterRevisionId !== (command.revisionId ?? undefined) ||
          !letter.actions.includes(command.kind)
        )
          throw new OrderAftercareFailure("PRECONDITION_CHANGED", 409);
        if (command.kind === "correct")
          await c
            .POST("/api/v1/admin/license-letters/{licenseLetterId}/correct", {
              ...common,
              params: { path: { licenseLetterId: command.letterId } },
              body: LicenseLetterCorrectBodySchema.parse(command.body),
            })
            .then(result);
        else
          await c
            .POST("/api/v1/admin/license-letters/{licenseLetterId}/void", {
              ...common,
              params: { path: { licenseLetterId: command.letterId } },
              body: LicenseLetterVoidBodySchema.parse(command.body),
            })
            .then(result);
      }
    },
    async pdf(orderId: string, itemId: string, letterId: string, signal: AbortSignal) {
      const current = (await licenses(orderId, itemId, signal)).items.find(
        (row) => row.licenseLetterId === letterId,
      );
      const revision = current?.currentRevision;
      if (
        !current ||
        current.status === "voided" ||
        !revision?.fileId ||
        revision.renderStatus !== "ready" ||
        !revision.readyAt
      )
        throw new OrderAftercareFailure("FILE_NOT_READY");
      const signed = await result(
        await c.POST("/api/v1/admin/files/{fileId}/download-urls", {
          params: { path: { fileId: revision.fileId } },
          body: { disposition: "attachment", purpose: "下载当前授权书" },
          signal,
        }),
      );
      const latest = (await licenses(orderId, itemId, signal)).items.find(
        (row) => row.licenseLetterId === letterId,
      );
      active(signal);
      if (
        !latest ||
        latest.status === "voided" ||
        latest.currentRevision?.licenseLetterRevisionId !== revision.licenseLetterRevisionId ||
        latest.currentRevision.fileId !== revision.fileId ||
        latest.currentRevision.renderStatus !== "ready"
      )
        throw new OrderAftercareFailure("PRECONDITION_CHANGED");
      if (Date.parse(signed.expiresAt) <= Date.now())
        throw new OrderAftercareFailure("FILE_NOT_READY");
      return signed.url;
    },
  };
}
export type OrderAftercareApi = ReturnType<typeof createOrderAftercareApi>;
export type CancelQuote = ReturnType<typeof CancelQuoteSchema.parse>;
export type LicenseList = Awaited<ReturnType<OrderAftercareApi["licenses"]>>;
export type LicenseLetter = LicenseList["items"][number];
export function orderCancelFingerprint(order: Pick<OrderDetail, "cancelRequests">) {
  return JSON.stringify(order.cancelRequests.map((row) => [row.cancelRequestId, row.status]));
}
