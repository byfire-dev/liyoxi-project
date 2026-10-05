// 一份接口文档的路由（W0-10）：一份文档一个目录，一个资源一个文件，文件里每条路由一个具名导出。
// 文档目录的 index.ts 把各资源文件整个交进来，这里按形态分拣：导出了就登记了，不存在“导出了却没登记”。
// 文件里别的导出（各域以后补的 Zod 结构）不管；长得像路由（有 method 与 path）却不是构造器产出的，报错。
import {
  ContractRouteError,
  isContractRoute,
  isRegistryOnlyEntry,
  routeGroupOf,
  type AnyContractRoute,
  type RegistryOnlyEntry,
} from "./builders.js";
import { isMetaOnlyRoute, type MetaOnlyRoute } from "./meta-only.js";
import type { RouteGroup } from "./meta.js";

export interface RouteDoc {
  /** 接口文档名，同 docs/api/ 下的文件名（不带扩展名），如 m01-account */
  readonly doc: string;
  /** 这份文档的路由都在哪一组 */
  readonly group: RouteGroup;
  readonly routes: readonly AnyContractRoute[];
  readonly metaOnly: readonly MetaOnlyRoute[];
  readonly registryOnly: readonly RegistryOnlyEntry[];
}

/** 文档名的首字母定组：m 商家端、a 后台、p 下载页、h 回调与探活 */
const DOC_GROUPS: Readonly<Record<string, RouteGroup>> = {
  m: "m",
  a: "admin",
  p: "portal",
  h: "hooks",
};
const DOC_NAME = /^[maph]\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

const looksLikeRoute = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { method?: unknown }).method === "string" &&
  typeof (value as { path?: unknown }).path === "string";

export function defineRouteDoc(
  doc: string,
  modules: readonly Readonly<Record<string, unknown>>[],
): RouteDoc {
  if (!DOC_NAME.test(doc)) {
    throw new ContractRouteError(`接口文档 ${doc}`, ["文档名须形如 m01-account、a01-system"]);
  }
  const group = DOC_GROUPS[doc.charAt(0)] as RouteGroup;
  const routes: AnyContractRoute[] = [];
  const metaOnly: MetaOnlyRoute[] = [];
  const registryOnly: RegistryOnlyEntry[] = [];
  const problems: string[] = [];
  for (const moduleExports of modules) {
    for (const [name, value] of Object.entries(moduleExports)) {
      if (isRegistryOnlyEntry(value)) {
        if (group !== "hooks") problems.push(`${name}：只登记的探活只放在回调与探活那份文档里`);
        registryOnly.push(value);
      } else if (isContractRoute(value) || isMetaOnlyRoute(value)) {
        if (routeGroupOf(value) !== group) {
          problems.push(`${name}：${value.operationId} 不属于 ${group} 组，不该在这份文档里`);
        }
        if (isMetaOnlyRoute(value)) metaOnly.push(value);
        else routes.push(value);
      } else if (looksLikeRoute(value)) {
        problems.push(`${name}：长得像路由，却不是构造器或登记函数的产出`);
      }
    }
  }
  if (problems.length > 0) throw new ContractRouteError(`接口文档 ${doc}`, problems);
  return Object.freeze({
    doc,
    group,
    routes: Object.freeze(routes),
    metaOnly: Object.freeze(metaOnly),
    registryOnly: Object.freeze(registryOnly),
  });
}
