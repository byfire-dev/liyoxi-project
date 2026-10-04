// 路由登记入口。M0 的骨架里没有真实路由：669 条元数据由 W0-10 接管，各域的结构随该域第一个后端 PR。
// 往后加路由：在各自的文件里用构造器写好并导出，再加进下面的登记表；
// 契约自测会点名“导出了却没登记”的路由。
import { defineRouteRegistry } from "./registry.js";

export * from "./builders.js";
export * from "./meta.js";
export * from "./registry.js";
export { pathParamNames, routeProblems, type RouteCheckInput } from "./validate.js";

/** 全部路由与只登记的条目 */
export const routeRegistry = defineRouteRegistry({ routes: [], registryOnly: [] });

/** 全部路由：生成脚本据此出三份 OpenAPI；api 据此注册处理器 */
export const allRoutes = routeRegistry.routes;

/** 只登记的条目（探活）：不进 OpenAPI */
export const allRegistryOnly = routeRegistry.registryOnly;
