import {
  AdminInvoiceSummarySchema,
  DictItemListSchema,
  InvoiceRequestAdminDetailSchema,
  InvoiceRequestAdminPageSchema,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure, requestIdTail } from "../../../lib/api-errors";
import type { InvoiceCommand, InvoiceDetail } from "./types";

export class InvoiceFailure extends Error {
  constructor(
    readonly symbol: string,
    readonly status = 0,
    readonly tail: string | null = null,
  ) {
    super(symbol);
  }
}
export function invoiceError(error: unknown) {
  const labels: Readonly<Record<string, string>> = {
    PERMISSION_DENIED: "当前权限无法读取或处理此申请",
    NOT_FOUND: "申请不存在或已不可见",
    VERSION_CONFLICT: "详情已变化，请重新读取并确认",
    CONFIRM_MISMATCH: "确认信息已变化，请重新核对",
    STATE_NOT_ALLOWED: "当前状态不允许此操作，请重新读取",
    INVOICE_ISSUE_BLOCKED: "付款或退款条件已变化，暂不能开具",
    INVOICE_NO_TAKEN: "发票代码与号码已被使用，请核对原票",
    FILE_NOT_USABLE: "文件尚未入库、归属不符或不可使用，请重新核对",
    DICT_ITEM_DISABLED: "原因或快递公司已停用，请重新选择",
    VALIDATION_FAILED: "请核对票号、文件与必填信息",
    STEP_UP_REQUIRED: "请完成再次验证后重试",
    IDEMPOTENCY_IN_PROGRESS: "同一操作仍在处理中，请稍后用原意图重试",
    RESPONSE_MISMATCH: "响应与当前申请不一致，已停止处理",
  };
  const message =
    labels[error instanceof InvoiceFailure ? error.symbol : "UNKNOWN"] ??
    "请求结果尚未确认，请保留原内容重试";
  return `${message}${error instanceof InvoiceFailure && error.tail ? `（请求编号 ${error.tail}）` : ""}`;
}
export const invoiceNeedsReload = (error: unknown) =>
  error instanceof InvoiceFailure &&
  (error.status === 409 || ["RESPONSE_MISMATCH", "INVOICE_ISSUE_BLOCKED"].includes(error.symbol));
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
  throw new InvoiceFailure(failure.symbol, failure.status, requestIdTail(failure.requestId));
}
function detail(value: unknown, id: string) {
  const row = InvoiceRequestAdminDetailSchema.parse(value);
  if (row.invoiceRequestId !== id) throw new InvoiceFailure("RESPONSE_MISMATCH");
  return row;
}
export function createInvoiceApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    async list(
      query: operations["admin.invoiceRequest.list"]["parameters"]["query"],
      signal: AbortSignal,
    ) {
      return InvoiceRequestAdminPageSchema.parse(
        await result(
          await client.GET("/api/v1/admin/invoice-requests", { params: { query }, signal }),
        ),
      );
    },
    async summary(
      query: operations["admin.invoiceRequest.summary"]["parameters"]["query"],
      signal: AbortSignal,
    ) {
      return AdminInvoiceSummarySchema.parse(
        await result(
          await client.GET("/api/v1/admin/invoice-requests/summary", { params: { query }, signal }),
        ),
      );
    },
    async get(id: string, signal: AbortSignal): Promise<InvoiceDetail> {
      return detail(
        await result(
          await client.GET("/api/v1/admin/invoice-requests/{invoiceRequestId}", {
            params: { path: { invoiceRequestId: id } },
            signal,
          }),
        ),
        id,
      );
    },
    async write(id: string, command: InvoiceCommand, key: string, signal: AbortSignal) {
      const common = {
        params: { path: { invoiceRequestId: id } },
        headers: { "Idempotency-Key": key },
        signal,
      };
      const response =
        command.action === "issue"
          ? await client.POST("/api/v1/admin/invoice-requests/{invoiceRequestId}/issue", {
              ...common,
              body: command.body,
            })
          : command.action === "issue-red"
            ? await client.POST("/api/v1/admin/invoice-requests/{invoiceRequestId}/issue-red", {
                ...common,
                body: command.body,
              })
            : command.action === "reject"
              ? await client.POST("/api/v1/admin/invoice-requests/{invoiceRequestId}/reject", {
                  ...common,
                  body: command.body,
                })
              : await client.POST(
                  "/api/v1/admin/invoice-requests/{invoiceRequestId}/resend",
                  common,
                );
      return detail(await result(response), id);
    },
    async dictionary(typeKey: string, signal: AbortSignal, scene?: string) {
      return DictItemListSchema.parse(
        await result(
          await client.GET("/api/v1/admin/dict-items", {
            params: { query: { typeKey, scene } },
            signal,
          }),
        ),
      );
    },
    async fileUrl(fileId: string, signal: AbortSignal) {
      return result(
        await client.POST("/api/v1/admin/files/{fileId}/download-urls", {
          params: { path: { fileId } },
          body: { disposition: "attachment", purpose: "核对发票文件" },
          signal,
        }),
      );
    },
  };
}
export type InvoiceApi = ReturnType<typeof createInvoiceApi>;
