// @liyoxi/contract：接口契约唯一手写源。本入口带 Zod 运行时，给 api、worker、admin、portal 用。
// 小程序与 shared 只引纯常量子路径（./errors、./enums、./registry、./config/flags、./config/params、./authz、
// ./notify、./analytics/events）与生成的类型（./types/*），不引本入口。
export { z } from "./zod.js";

export * from "./errors/index.js";
export * from "./enums/index.js";
export * from "./enums/zod.js";
export * from "./registry/index.js";
export * from "./config/flags.js";
export * from "./config/params.js";
export * from "./authz/index.js";
export * from "./resources/index.js";
export * from "./notify/index.js";
export * from "./analytics/events.js";
export * from "./common/index.js";
export * from "./routes/index.js";
export * from "./openapi.js";
// W0-18：config 各 jsonb 列的结构（开关规则、清单条目、站点配置、字典项扩展属性）
export * from "./config/schemas.js";
export * from "./config/dict-ext.js";
// W0-14：审计日志的登记值与 jsonb 结构
export * from "./audit/index.js";
