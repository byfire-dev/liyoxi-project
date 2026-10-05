// “只有元数据、没有结构”的登记形态（W0-10；任务书 第 11 节第 1 项）。
// 一条路由在所属的域写出请求与响应的 Zod 结构之前，先以这种形态登记：是谁、谁能调、怎么幂等都已定下，
// 把关与四个构造器是同一套（routeProblems、同样的缺省值），只是不进 OpenAPI，api 也不挂它。
// 域包补结构时：把 merchantMeta(...) 换成 merchantRoute(...)，补上 request 与 responses，其余字段不动。
// 能力点、权限点在这里按类型收紧：只取契约登记的键（@liyoxi/contract/authz），另许 assert-in-handler 与 null。
import type { CapabilityKey, PermissionKey } from "../authz/index.js";

import { ContractRouteError, metaWithDefaults, type MethodDecl } from "./builders.js";
import {
  API_PREFIX,
  type ASSERT_IN_HANDLER,
  type ClerkView,
  type GROUP_AUTH,
  type RouteGroup,
  type RouteMeta,
  type RouteMethod,
} from "./meta.js";
import { routeProblems } from "./validate.js";

/** 能力点的取值：登记过的键、处理器内判定，或 null（不设） */
export type CapabilityRef = CapabilityKey | typeof ASSERT_IN_HANDLER | null;
/** 权限点的取值：登记过的键、处理器内判定，或 null（不设） */
export type PermissionRef = PermissionKey | typeof ASSERT_IN_HANDLER | null;

type AuthOf<G extends RouteGroup> = (typeof GROUP_AUTH)[G]["allowed"][number];

/** 各组共有的部分：与构造器的声明同名同义，少了 request 与 responses */
interface MetaShape {
  /** 约定里的写法，不带 /api/v1 */
  path: string;
  operationId: string;
  summary?: string;
  "x-three-phase"?: true;
  "x-rate-limit"?: string;
}

export type MerchantMetaDef = MetaShape &
  MethodDecl & {
    "x-auth"?: AuthOf<"m">;
    "x-capability"?: CapabilityRef;
    "x-clerk-view": ClerkView;
  };

export type AdminMetaDef = MetaShape &
  MethodDecl & {
    "x-auth"?: AuthOf<"admin">;
    "x-permission": PermissionRef;
    "x-step-up"?: "skip";
  };

export type PortalMetaDef = MetaShape &
  MethodDecl & {
    "x-auth": AuthOf<"portal">;
    "x-capability"?: CapabilityRef;
  };

export type HookMetaDef = MetaShape & MethodDecl;

/** 登记的产出：路径已带 /api/v1，元数据已补缺省值 */
export interface MetaOnlyRoute extends RouteMeta {
  readonly metaOnly: true;
  readonly method: RouteMethod;
  readonly path: string;
  readonly summary?: string;
}

const builtEntries = new WeakSet<object>();

/** 是不是由本文件的四个函数登记的 */
export function isMetaOnlyRoute(value: unknown): value is MetaOnlyRoute {
  return typeof value === "object" && value !== null && builtEntries.has(value);
}

function build(group: RouteGroup, def: MetaShape & { method: RouteMethod }): MetaOnlyRoute {
  const meta = metaWithDefaults(group, def);
  const problems = routeProblems({ group, method: def.method, path: def.path, meta });
  if (problems.length > 0) {
    throw new ContractRouteError(`路由 ${def.operationId}（${def.method} ${def.path}）`, problems);
  }
  const entry = Object.freeze({
    metaOnly: true,
    method: def.method,
    path: `${API_PREFIX}${def.path}`,
    ...(def.summary === undefined ? {} : { summary: def.summary }),
    ...meta,
  }) as unknown as MetaOnlyRoute;
  builtEntries.add(entry);
  return entry;
}

/** 商家端：/m/* */
export function merchantMeta(def: MerchantMetaDef): MetaOnlyRoute {
  return build("m", def);
}

/** 后台：/admin/* */
export function adminMeta(def: AdminMetaDef): MetaOnlyRoute {
  return build("admin", def);
}

/** 下载页：/portal/* */
export function portalMeta(def: PortalMetaDef): MetaOnlyRoute {
  return build("portal", def);
}

/** 回调：/hooks/* */
export function hookMeta(def: HookMetaDef): MetaOnlyRoute {
  return build("hooks", def);
}
