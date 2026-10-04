// 信封与错误体（约定 C21、C22、C24），以及路由里声明响应的写法。
import { z } from "../zod.js";

import type { ErrorHttpStatus } from "../errors/index.js";

/** 成功体 { code: 0, message: "ok", data }（约定 C21） */
export function envelope<T extends z.ZodType>(data: T) {
  return z.object({ code: z.literal(0), message: z.literal("ok"), data });
}

/** 没有返回内容的写接口：data 为 null（约定 C21） */
export const NoDataSchema = z.null();

/** 字段错误：path 是点分路径，数组下标写数字 */
export const FieldErrorSchema = z.object({ path: z.string(), message: z.string() });

/** 错误体（约定 C22）。fieldErrors 只随 VALIDATION_FAILED；details 的结构按错误码登记 */
export const ErrorBodySchema = z
  .object({
    code: z.int(),
    error: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    requestId: z.string(),
    fieldErrors: z.array(FieldErrorSchema).optional(),
    details: z.unknown().optional(),
  })
  .openapi("ErrorBody");

const JSON_CONTENT = "application/json";

/** 一个状态下的 JSON 响应声明 */
type JsonResponseDecl<S extends z.ZodType> = {
  description: string;
  content: { [JSON_CONTENT]: { schema: S } };
};

/**
 * 以状态码为键的响应声明。写成映射类型：键保持数字字面量，
 * 与别的声明用 ... 拼在一起后，app.openapi() 仍能按状态码推出处理器的返回类型。
 */
type ResponseDecls<Status extends number, S extends z.ZodType> = {
  [K in Status]: JsonResponseDecl<S>;
};

const jsonResponse = <Status extends number, S extends z.ZodType>(
  status: Status,
  description: string,
  schema: S,
) =>
  ({ [status]: { description, content: { [JSON_CONTENT]: { schema } } } }) as ResponseDecls<
    Status,
    S
  >;

/** 200：全部同步成功，包括创建（约定 C24） */
export function okResponse<T extends z.ZodType>(data: T, description = "成功") {
  return jsonResponse(200, description, envelope(data));
}

/** 202：只用于“已收下、未处理”的转发类接口（约定 C24） */
export function acceptedResponse(description = "已收下，未处理") {
  return jsonResponse(202, description, envelope(NoDataSchema));
}

const ERROR_DESCRIPTIONS: Record<ErrorHttpStatus, string> = {
  400: "入参不合约定，或业务规则拒绝了输入本身",
  401: "未登录或会话失效",
  403: "已登录但无权",
  404: "资源不存在，或不在当前门店、主体、数据范围内",
  409: "状态不允许、版本冲突、唯一性冲突或幂等键冲突",
  410: "凭证类资源已失效",
  426: "客户端版本过低",
  428: "需要先同意协议",
  429: "限流",
  500: "内部错误",
  503: "外部能力不可用、系统繁忙或停机维护",
  504: "上游超时",
};

/** 错误响应的声明：传入本接口可能返回的 HTTP 状态 */
export function errorResponses<const S extends readonly ErrorHttpStatus[]>(
  ...statuses: S
): ResponseDecls<S[number], typeof ErrorBodySchema> {
  const out: Partial<ResponseDecls<ErrorHttpStatus, typeof ErrorBodySchema>> = {};
  for (const status of statuses) {
    Object.assign(out, jsonResponse(status, ERROR_DESCRIPTIONS[status], ErrorBodySchema));
  }
  return out as ResponseDecls<S[number], typeof ErrorBodySchema>;
}
