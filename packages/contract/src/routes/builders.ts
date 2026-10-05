// 四个路由构造器：商家端、后台、下载页、回调（约定 C75），外加“只登记”的探活条目（约定 C1）。
// 路径照约定的写法写（/m/orders/{orderId}，不带 /api/v1），构造器补前缀与缺省值、把关声明，
// 产出可直接交给 app.openapi(route, handler) 的路由对象。声明不全在构造时就抛错。
import { createRoute, type RouteConfig } from "@hono/zod-openapi";

import { z } from "../zod.js";
import {
  API_PREFIX,
  GROUP_AUTH,
  OPERATION_ID_PATTERN,
  READ_IDEMPOTENT_REASON,
  ROUTE_META_EXTENSION_KEYS,
  type ClerkView,
  type RouteGroup,
  type RouteMeta,
  type RouteMethod,
  type WriteMethod,
} from "./meta.js";
import { routeProblems } from "./validate.js";

type RouteRequest = NonNullable<RouteConfig["request"]>;
type RouteResponses = RouteConfig["responses"];

/** 各组共有的部分 */
interface RouteShape<P extends string> {
  /** 约定里的写法，不带 /api/v1 */
  path: P;
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  request?: RouteRequest;
  responses: RouteResponses;
  "x-three-phase"?: true;
  "x-rate-limit"?: string;
}

/** GET 不写库：幂等方式固定 none，可以不写 */
interface ReadDecl {
  method: "get";
  "x-idempotent"?: "none";
  "x-idempotent-reason"?: string;
}

/** 写路由必须显式声明幂等方式，不给缺省（任务书 W0-08 第 11 节第 4 项） */
type WriteDecl = { method: WriteMethod } & (
  | {
      "x-idempotent": "required";
      "x-idempotent-reason"?: string;
      "x-redact-on-replay"?: readonly string[];
    }
  | {
      "x-idempotent": "natural";
      "x-idempotent-by": readonly [string, ...string[]];
      "x-idempotent-reason"?: string;
    }
  | { "x-idempotent": "none"; "x-idempotent-reason": string }
);

export type MethodDecl = ReadDecl | WriteDecl;
type AuthOf<G extends RouteGroup> = (typeof GROUP_AUTH)[G]["allowed"][number];

/** 商家端：x-auth 缺省 member；x-clerk-view 必填；x-capability 不写即不设能力点 */
export type MerchantRouteDef<P extends string = string> = RouteShape<P> &
  MethodDecl & {
    "x-auth"?: AuthOf<"m">;
    "x-capability"?: string | null;
    "x-clerk-view": ClerkView;
  };

/** 后台：x-auth 缺省 staff；x-permission 必填，可取 assert-in-handler，不设权限点须显式写 null */
export type AdminRouteDef<P extends string = string> = RouteShape<P> &
  MethodDecl & {
    "x-auth"?: AuthOf<"admin">;
    "x-permission": string | null;
    "x-step-up"?: "skip";
  };

/** 下载页：约定没有给 x-auth 缺省，须显式声明 */
export type PortalRouteDef<P extends string = string> = RouteShape<P> &
  MethodDecl & {
    "x-auth": AuthOf<"portal">;
    "x-capability"?: string | null;
  };

/** 回调：x-auth 固定 signed；不出 OpenAPI 文档 */
export type HookRouteDef<P extends string = string> = RouteShape<P> & MethodDecl;

type AnyRouteDef = RouteShape<string> & { method: RouteMethod };

/**
 * 构造器的产出：路径已带 /api/v1，元数据已补缺省值。
 * 末尾的索引签名是给 app.openapi() 看的：它要求路由对象接受任意 x- 扩展键。
 */
export type ContractRoute<D extends AnyRouteDef = AnyRouteDef> = Omit<D, "path" | keyof RouteMeta> &
  RouteMeta & {
    path: `${typeof API_PREFIX}${D["path"]}`;
    getRoutingPath(): string;
  } & { [extension: `x-${string}`]: unknown };

/** 不关心具体结构时用的宽类型 */
export type AnyContractRoute = ContractRoute;

/** 声明不合约定时抛出；problems 逐条列出问题 */
export class ContractRouteError extends Error {
  readonly problems: readonly string[];

  constructor(subject: string, problems: readonly string[]) {
    super(`${subject} 的声明有 ${problems.length} 处问题：\n- ${problems.join("\n- ")}`);
    this.name = "ContractRouteError";
    this.problems = problems;
  }
}

const builtRoutes = new WeakSet<object>();

/** 是不是由本文件的构造器构造的路由 */
export function isContractRoute(value: unknown): value is AnyContractRoute {
  return typeof value === "object" && value !== null && builtRoutes.has(value);
}

/** 路由属于哪一组：取 operationId 的第一段 */
export function routeGroupOf(route: Pick<RouteMeta, "operationId">): RouteGroup {
  return route.operationId.slice(0, route.operationId.indexOf(".")) as RouteGroup;
}

/** 取出元数据并补缺省值。“只有元数据”的登记形态（meta-only.ts）也用它，两种形态的缺省值是同一套 */
export function metaWithDefaults(
  group: RouteGroup,
  def: { operationId: string; method: RouteMethod },
): Record<string, unknown> {
  const source = def as unknown as Record<string, unknown>;
  const meta: Record<string, unknown> = { operationId: def.operationId };
  for (const key of ROUTE_META_EXTENSION_KEYS) {
    if (source[key] !== undefined) meta[key] = source[key];
  }
  const fallbackAuth = GROUP_AUTH[group].fallback;
  if (meta["x-auth"] === undefined && fallbackAuth !== null) meta["x-auth"] = fallbackAuth;
  if (def.method === "get") {
    meta["x-idempotent"] ??= "none";
    if (meta["x-idempotent"] === "none") meta["x-idempotent-reason"] ??= READ_IDEMPOTENT_REASON;
  }
  if (group === "m" || group === "portal") meta["x-capability"] ??= null;
  return meta;
}

/** request.params 的键：没有声明返回 null；不是对象结构时返回 undefined（不查） */
function paramKeysOf(request: RouteRequest | undefined): string[] | null | undefined {
  const params: unknown = request?.params;
  if (params === undefined) return null;
  return params instanceof z.ZodObject ? Object.keys(params.shape) : undefined;
}

function build(group: RouteGroup, def: AnyRouteDef): AnyContractRoute {
  const { path, ...rest } = def;
  const meta = metaWithDefaults(group, def);
  const problems = routeProblems({
    group,
    method: def.method,
    path,
    meta,
    responseStatuses: Object.keys(def.responses ?? {}),
    paramKeys: paramKeysOf(def.request),
  });
  if (problems.length > 0) {
    throw new ContractRouteError(`路由 ${def.operationId}（${def.method} ${path}）`, problems);
  }
  const route = createRoute({ ...rest, ...meta, path: `${API_PREFIX}${path}` });
  builtRoutes.add(route);
  return Object.freeze(route) as unknown as AnyContractRoute;
}

/** 商家端路由：/m/* */
export function merchantRoute<P extends string, D extends MerchantRouteDef<P>>(
  def: D,
): ContractRoute<D> {
  return build("m", def) as ContractRoute<D>;
}

/** 后台路由：/admin/* */
export function adminRoute<P extends string, D extends AdminRouteDef<P>>(def: D): ContractRoute<D> {
  return build("admin", def) as ContractRoute<D>;
}

/** 下载页路由：/portal/* */
export function portalRoute<P extends string, D extends PortalRouteDef<P>>(
  def: D,
): ContractRoute<D> {
  return build("portal", def) as ContractRoute<D>;
}

/** 回调路由：/hooks/*。应答体按 Provider 协议，不套信封 */
export function hookRoute<P extends string, D extends HookRouteDef<P>>(def: D): ContractRoute<D> {
  return build("hooks", def) as ContractRoute<D>;
}

/** 只登记的条目：根路径探活与内网明细，不进 OpenAPI、不分配 operationId（约定 C1、C74） */
export interface RegistryOnlyEntry {
  readonly registryKeyOnly: true;
  /** 只作清单编号，如 hooks.healthz.get；不作幂等作用域，不进限流与豁免清单 */
  readonly registryKey: string;
  readonly method: "get";
  /** 根路径，不在 /api/v1 之下 */
  readonly path: string;
  readonly "x-auth": "public";
  /** /internal/health/* 只靠网络隔离，在 public 黄金文件里标“仅内网” */
  readonly internalOnly: boolean;
  readonly summary?: string;
}

const PROBE_PATH = /^\/(?:healthz|readyz|health|internal\/health\/[a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function registryOnly(def: {
  registryKey: string;
  path: string;
  summary?: string;
}): RegistryOnlyEntry {
  const problems: string[] = [];
  if (!OPERATION_ID_PATTERN.test(def.registryKey) || !def.registryKey.startsWith("hooks.")) {
    problems.push(`登记键 ${def.registryKey} 须形如 hooks.healthz.get`);
  }
  if (!PROBE_PATH.test(def.path)) {
    problems.push(
      `路径 ${def.path} 须为 /healthz、/readyz、/health 或 /internal/health/<名字>：只登记的条目只有探活`,
    );
  }
  if (problems.length > 0)
    throw new ContractRouteError(`只登记的条目 ${def.registryKey}`, problems);
  return Object.freeze({
    registryKeyOnly: true,
    registryKey: def.registryKey,
    method: "get",
    path: def.path,
    "x-auth": "public",
    internalOnly: def.path.startsWith("/internal/"),
    ...(def.summary === undefined ? {} : { summary: def.summary }),
  });
}

export function isRegistryOnlyEntry(value: unknown): value is RegistryOnlyEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { registryKeyOnly?: unknown }).registryKeyOnly === true
  );
}
