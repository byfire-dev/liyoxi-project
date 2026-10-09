import { readFailure, type ApiFailure } from "../../../lib/api-errors";

export class ConfigFailure extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}
export async function configResult<T>(result: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (!result.data) {
    // openapi-fetch已读取失败body；复用实际解析值，再交原公共错误适配，不能把409降成HTTP_409。
    const response =
      result.error === undefined
        ? result.response
        : new Response(JSON.stringify(result.error), {
            status: result.response.status,
            headers: result.response.headers,
          });
    throw new ConfigFailure(await readFailure(response));
  }
  return result.data.data;
}
export function failureFields(error: unknown): Record<string, string> {
  return error instanceof ConfigFailure
    ? Object.fromEntries(
        (error.failure.body?.fieldErrors ?? []).map((item) => [item.path, item.message]),
      )
    : {};
}
export function errorMessage(error: unknown): string {
  if (error instanceof ConfigFailure && error.failure.symbol === "DICT_ITEM_IN_USE") {
    const details = error.failure.body?.details;
    const count =
      typeof details === "object" && details !== null && "refCount" in details
        ? details.refCount
        : undefined;
    return `此项仍被引用${typeof count === "number" ? ` ${count} 次` : ""}，不能停用`;
  }
  if (error instanceof ConfigFailure && error.failure.symbol === "VALIDATION_FAILED") {
    const fields = error.failure.body?.fieldErrors;
    if (fields?.length) return fields.map(({ path, message }) => `${path}：${message}`).join("；");
  }
  return error instanceof Error ? error.message : "请求没有成功，请重试";
}
export function isConflict(error: unknown): boolean {
  return error instanceof ConfigFailure && error.failure.symbol === "VERSION_CONFLICT";
}
