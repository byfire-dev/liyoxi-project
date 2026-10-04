// @liyoxi/contract/errors：纯常量子路径。小程序与 shared 从这里拿错误码，带不进 Zod 运行时。
// 本目录下的文件不得 import zod、@hono/zod-openapi、hono（连 import type 也不行，门禁按可达性算）；
// 契约自测静态扫描本入口可达的全部文件。
export { HTTP_STATUSES } from "./types.js";
export type { ErrorBody, ErrorCodeDef, ErrorHttpStatus, FieldError, HttpStatus } from "./types.js";
export { COMMON_ERRORS, COMMON_ERROR_SYMBOLS, isCommonErrorSymbol } from "./common.js";
export type { CommonErrorDetails, CommonErrorSymbol, PendingConsentPlaceholder } from "./common.js";
