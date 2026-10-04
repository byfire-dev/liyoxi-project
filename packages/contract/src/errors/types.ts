// 错误码与错误体的类型（约定 C22、C25）。纯类型，不引任何包：小程序经 ./errors 子路径拿到。

/** 接口只用这几个 HTTP 状态；不用 201、204、422（约定 C24） */
export const HTTP_STATUSES = [
  200, 202, 400, 401, 403, 404, 409, 410, 426, 428, 429, 500, 503, 504,
] as const;
export type HttpStatus = (typeof HTTP_STATUSES)[number];

/** 错误响应可用的 HTTP 状态 */
export type ErrorHttpStatus = Exclude<HttpStatus, 200 | 202>;

/** 一个错误码的定义：符号名是表的键，其余四列同源（约定 C25） */
export interface ErrorCodeDef {
  /** 数值码，五位，只用于日志与排障 */
  readonly code: number;
  /** HTTP 状态 */
  readonly http: ErrorHttpStatus;
  /** 用同一请求（同一幂等键）稍后重试是否可能成功（约定 C26） */
  readonly retryable: boolean;
  /** 默认文案：能直接给用户看的话。服务端可按场景换成更具体的 */
  readonly message: string;
  /** 是否带 details；结构按符号名登记在 Zod 一侧（common/error-details.ts） */
  readonly hasDetails: boolean;
}

/** 字段错误：只随 VALIDATION_FAILED 出现 */
export interface FieldError {
  /** 点分路径，数组下标写数字，如 items.0.dramaId */
  path: string;
  message: string;
}

/** 错误体（约定 C22）。端上逻辑只按 error 判断，code 只用于日志与排障 */
export interface ErrorBody<TDetails = unknown> {
  code: number;
  /** 符号名 */
  error: string;
  message: string;
  retryable: boolean;
  /** 等于回包头 X-Request-Id */
  requestId: string;
  /** 只随 VALIDATION_FAILED */
  fieldErrors?: FieldError[];
  /** 该错误码在契约里声明的附加数据；同一个码的 details 类型唯一 */
  details?: TDetails;
}
