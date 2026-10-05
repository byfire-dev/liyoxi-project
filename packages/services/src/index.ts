
// W0-07b 服务装配：组合根。api、worker 启动时各调一次 assembleServices
export { assembleServices } from "./assembly.js";
export type { AssembleServicesOptions } from "./assembly.js";
export { AssemblyError } from "./kernel/index.js";
export type { Assembly, AssemblyEntry, AssemblyIssue } from "./kernel/index.js";
// @liyoxi/services 的包入口：应用层只从这里取业务能力。各包只在末尾加自己的导出行。
// W0-14：敏感字段与审计。按模块名取用：security.sealPhone(…)、audit.record(…)
export * as security from "./security/index.js";
export * as audit from "./audit/index.js";
