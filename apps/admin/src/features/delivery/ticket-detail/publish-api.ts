import {
  DeliveryReleasePackResultSchema,
  PublishListSaveResultSchema,
  PublishListImportResultSchema,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";
type Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer T } };
}
  ? T
  : never;
export type PublishReplace = Body<"admin.deliveryTicket.publishList.replace">;
export type PublishImport = Body<"admin.deliveryTicket.publishList.import">;
export class PublishFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
    readonly details?: unknown,
    readonly fieldErrors?: unknown,
  ) {
    super(message);
  }
}
export async function publishResult<T>(result: {
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
  const failure = await readFailure(response);
  throw new PublishFailure(
    failure.message,
    failure.symbol,
    failure.status,
    failure.body?.details,
    failure.body?.fieldErrors,
  );
}
export function createPublishApi(services: Pick<AppServices, "api">) {
  const c = services.api.client;
  const params = (deliveryTicketId: string) => ({ path: { deliveryTicketId } });
  const write = (key: string, signal: AbortSignal) => ({
    headers: { "Idempotency-Key": key },
    signal,
  });
  return {
    get: (id: string, signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/delivery-tickets/{deliveryTicketId}/publish-list", {
          params: params(id),
          signal,
        })
        .then(publishResult),
    replace: (id: string, body: PublishReplace, key: string, signal: AbortSignal) =>
      c
        .PUT("/api/v1/admin/delivery-tickets/{deliveryTicketId}/publish-list", {
          params: params(id),
          body,
          ...write(key, signal),
        })
        .then(publishResult)
        .then((value) => PublishListSaveResultSchema.parse(value)),
    import: (id: string, body: PublishImport, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/publish-list/import", {
          params: params(id),
          body,
          ...write(key, signal),
        })
        .then(publishResult)
        .then((value) => PublishListImportResultSchema.parse(value)),
    history: (id: string, signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/order-items/{orderItemId}/downloads", {
          params: { path: { orderItemId: id } },
          signal,
        })
        .then(publishResult),
    pack: (id: string, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/delivery-releases/{deliveryReleaseId}/pack", {
          params: { path: { deliveryReleaseId: id } },
          body: {},
          ...write(key, signal),
        })
        .then(publishResult)
        .then((value) => {
          const parsed = DeliveryReleasePackResultSchema.parse(value);
          if (parsed.deliveryReleaseId !== id)
            throw new Error("打包结果所属版本不一致，请保留原意图重试");
          return parsed;
        }),
    accounts: (storeId: string, page: number, signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/channel-accounts", {
          params: { query: { storeId, status: "available", page, pageSize: 100 } },
          signal,
        })
        .then(publishResult),
  };
}
export type PublishApi = ReturnType<typeof createPublishApi>;
export type PublishList = Awaited<ReturnType<PublishApi["get"]>>;
export type PublishAccount = Awaited<ReturnType<PublishApi["accounts"]>>["items"][number];
export type PackResult = Awaited<ReturnType<PublishApi["pack"]>>;
export async function allPublishAccounts(
  api: Pick<PublishApi, "accounts">,
  storeId: string,
  signal?: AbortSignal,
) {
  const rows = new Map<string, PublishAccount>();
  for (let page = 1; ; page++) {
    signal?.throwIfAborted();
    const result = await api.accounts(storeId, page, signal);
    if (result.page !== page || result.pageSize < 1)
      throw new Error("发布账号分页响应不一致，请重新加载");
    for (const row of result.items)
      if (
        row.store.storeId === storeId &&
        row.status === "available" &&
        ["douyin", "wechat_channels"].includes(row.platform)
      )
        rows.set(row.channelAccountId, row);
    if (result.page * result.pageSize >= result.total) return [...rows.values()];
    if (!result.items.length) throw new Error("发布账号分页不完整，请重新加载");
  }
}
function publishFields(error: unknown): { path: string; message: string }[] {
  if (!(error instanceof PublishFailure) || !Array.isArray(error.fieldErrors)) return [];
  return error.fieldErrors.filter(
    (field): field is { path: string; message: string } =>
      field !== null &&
      typeof field === "object" &&
      typeof field.path === "string" &&
      typeof field.message === "string",
  );
}
function publishFieldLabel(path: string) {
  const labels: Record<string, string> = {
    collectionName: "合集名称",
    coverFileId: "清单封面",
    titleTemplate: "标题模板",
    topics: "通用话题",
    intro: "通用简介",
    lockVersion: "清单版本",
  };
  const [field, index, child, item] = path.split(".");
  if (field === "episodes" && index && /^\d+$/.test(index)) {
    const name = (
      { highlight: "看点", title: "标题", topics: "话题", intro: "简介" } as Record<string, string>
    )[child ?? ""];
    if (name)
      return `第 ${Number(index) + 1} 集${name}${item && /^\d+$/.test(item) ? ` · 第 ${Number(item) + 1} 项` : ""}`;
  }
  return `${labels[field ?? ""] ?? path}${field === "topics" && index && /^\d+$/.test(index) ? ` · 第 ${Number(index) + 1} 项` : ""}`;
}
function publishFieldMessage(field: { path: string; message: string }) {
  if (/^(?:episodes\.\d+\.)?topics(?:\.\d+)?$/.test(field.path)) {
    if (field.message === "Too big: expected string to have <=21 characters")
      return "话题内容（不含开头的 #）不能超过20个字符";
    if (field.message === "Invalid input") return "每个话题须为1–20个字符，最多10项，且不能重复";
  }
  return field.message;
}
export function publishFieldError(error: unknown, path: string) {
  return (
    publishFields(error)
      .filter((field) => field.path === path || field.path.startsWith(`${path}.`))
      .map((field) => `${publishFieldLabel(field.path)}：${publishFieldMessage(field)}`)
      .join("\n") || undefined
  );
}
export function publishError(error: unknown) {
  if (!(error instanceof Error)) return "请求失败，请重试";
  const fields = publishFields(error).map(
    (field) => `${publishFieldLabel(field.path)}：${publishFieldMessage(field)}`,
  );
  const message = [error.message, ...fields].join("\n");
  if (!(error instanceof PublishFailure) || !error.details) return message;
  const details = error.details;
  const rows =
    typeof details === "object" && details !== null
      ? "rows" in details
        ? details.rows
        : "issues" in details
          ? details.issues
          : details
      : details;
  const text = Array.isArray(rows)
    ? rows
        .map((row: unknown) => {
          if (typeof row === "string") return row;
          if (row && typeof row === "object" && "message" in row) {
            const line = "rowNo" in row ? `第 ${String(row.rowNo)} 行 · ` : "";
            const column = "column" in row ? `${String(row.column)}：` : "";
            return `${line}${column}${String(row.message)}`;
          }
          return JSON.stringify(row);
        })
        .join("\n")
    : JSON.stringify(rows);
  return `${message}\n${text}`;
}
