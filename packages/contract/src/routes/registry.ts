// 路由登记：全部路由进一张表，生成脚本据此出 OpenAPI，api 据此注册处理器。
// 登记时把关：只收构造器的产出；operationId、登记键、“方法 + 路径”各自不重复。
// 三种形态：带结构的路由（进 OpenAPI）、只有元数据的路由（W0-10，结构随各域补）、只登记的探活。
import {
  ContractRouteError,
  isContractRoute,
  isRegistryOnlyEntry,
  type AnyContractRoute,
  type RegistryOnlyEntry,
} from "./builders.js";
import { isMetaOnlyRoute, type MetaOnlyRoute } from "./meta-only.js";

export interface RouteRegistry {
  /** 有 operationId 的路由：商家端、后台、下载页、回调 */
  readonly routes: readonly AnyContractRoute[];
  /** 只登记的条目：探活 */
  readonly registryOnly: readonly RegistryOnlyEntry[];
  /** 只有元数据、还没有结构的路由：不进 OpenAPI，api 不挂 */
  readonly metaOnly: readonly MetaOnlyRoute[];
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

/** 登记表有哪些问题；没有问题返回空数组 */
export function routeRegistryProblems(
  routes: readonly unknown[],
  registryOnly: readonly unknown[] = [],
  metaOnly: readonly unknown[] = [],
): string[] {
  const problems: string[] = [];
  const built = routes.filter(isContractRoute);
  if (built.length !== routes.length) {
    problems.push(
      `有 ${routes.length - built.length} 条路由不是由 merchantRoute / adminRoute / portalRoute / hookRoute 构造的`,
    );
  }
  const entries = registryOnly.filter(isRegistryOnlyEntry);
  if (entries.length !== registryOnly.length) {
    problems.push(
      `有 ${registryOnly.length - entries.length} 个只登记的条目不是由 registryOnly 构造的`,
    );
  }
  const metas = metaOnly.filter(isMetaOnlyRoute);
  if (metas.length !== metaOnly.length) {
    problems.push(
      `有 ${metaOnly.length - metas.length} 条只有元数据的路由不是由 merchantMeta / adminMeta / portalMeta / hookMeta 登记的`,
    );
  }
  const keys = [
    ...built.map((route) => route.operationId),
    ...metas.map((route) => route.operationId),
    ...entries.map((entry) => entry.registryKey),
  ];
  for (const key of duplicates(keys)) problems.push(`operationId 或登记键重复：${key}`);
  const endpoints = [...built, ...metas, ...entries].map((item) => `${item.method} ${item.path}`);
  for (const endpoint of duplicates(endpoints)) problems.push(`方法与路径重复：${endpoint}`);
  return problems;
}

/** 登记入口：有问题即抛错 */
export function defineRouteRegistry(input: {
  routes: readonly AnyContractRoute[];
  registryOnly?: readonly RegistryOnlyEntry[];
  metaOnly?: readonly MetaOnlyRoute[];
}): RouteRegistry {
  const registryOnly = input.registryOnly ?? [];
  const metaOnly = input.metaOnly ?? [];
  const problems = routeRegistryProblems(input.routes, registryOnly, metaOnly);
  if (problems.length > 0) throw new ContractRouteError("路由登记表", problems);
  return Object.freeze({
    routes: Object.freeze([...input.routes]),
    registryOnly: Object.freeze([...registryOnly]),
    metaOnly: Object.freeze([...metaOnly]),
  });
}

const looksLikeRoute = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { method?: unknown }).method === "string" &&
  typeof (value as { path?: unknown }).path === "string";

/**
 * “导出的路由都已登记”：传入一个模块的全部导出，返回导出了却没进登记表的名字。
 * 漏登记的路由不进 OpenAPI，端上拿不到类型，api 也不会挂它。
 * 按形状认路由（有 method 与 path），所以绕开构造器直接写的路由也会被点名。
 */
export function findUnregisteredRoutes(
  moduleExports: Readonly<Record<string, unknown>>,
  registry: RouteRegistry,
): string[] {
  const registered = new Set<unknown>([
    ...registry.routes,
    ...registry.registryOnly,
    ...registry.metaOnly,
  ]);
  return Object.entries(moduleExports)
    .filter(([, value]) => looksLikeRoute(value) && !registered.has(value))
    .map(([name]) => name)
    .sort();
}
