// 路由元数据的取值与类型（约定 C1、C2、C14、C47、C55、C75）。
// 键名直接用约定里的写法（x-auth、x-idempotent……），声明什么，OpenAPI 里就是什么。
import type { Milestone } from "../registry/define.js";

/** 四组接口都挂在这个前缀下；探活在根路径，不在其内（约定 C1） */
export const API_PREFIX = "/api/v1";

/** 四组：商家端、后台、下载页、回调。也是 operationId 的第一段与路径的第一段 */
export const ROUTE_GROUPS = ["m", "admin", "portal", "hooks"] as const;
export type RouteGroup = (typeof ROUTE_GROUPS)[number];

/** x-auth 的七个取值（约定 C2） */
export const X_AUTH_VALUES = [
  "public",
  "optional",
  "signed",
  "user",
  "member",
  "staff",
  "portal",
] as const;
export type XAuth = (typeof X_AUTH_VALUES)[number];

/**
 * 各组可用的 x-auth 与缺省值（约定 C2、C75）：商家端缺省 member，后台缺省 staff；
 * 下载页没有写缺省，须显式声明；回调固定 signed（约定 C6）。
 * staff 只在后台、portal 只在下载页、user 与 member 只在商家端。
 */
export const GROUP_AUTH = {
  m: { fallback: "member", allowed: ["public", "optional", "signed", "user", "member"] },
  admin: { fallback: "staff", allowed: ["public", "optional", "staff"] },
  portal: { fallback: null, allowed: ["public", "optional", "signed", "portal"] },
  hooks: { fallback: "signed", allowed: ["signed"] },
} as const satisfies Record<RouteGroup, { fallback: XAuth | null; allowed: readonly XAuth[] }>;

/** x-clerk-view：店员 403、与老板相同、裁剪后的店员结构（约定 C55） */
export const CLERK_VIEWS = ["none", "same", "trimmed"] as const;
export type ClerkView = (typeof CLERK_VIEWS)[number];

/** x-idempotent：一条路由只有一种幂等方式（约定 C47） */
export const X_IDEMPOTENT_VALUES = ["required", "natural", "none"] as const;
export type XIdempotent = (typeof X_IDEMPOTENT_VALUES)[number];

/** 权限取决于对象或请求体时，x-capability、x-permission 可取这个值（约定 C66） */
export const ASSERT_IN_HANDLER = "assert-in-handler";

/** 接口只用这五个方法（约定 C12） */
export const ROUTE_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];
export type WriteMethod = Exclude<RouteMethod, "get">;

/** operationId = <组>.<资源单数驼峰>[.<子资源>].<动作驼峰>，全仓唯一（约定 C14） */
export const OPERATION_ID_PATTERN =
  /^(m|admin|portal|hooks)\.[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){1,2}$/;

/** GET 不写库，幂等方式固定为 none；没写理由时用这一句（约定 C47） */
export const READ_IDEMPOTENT_REASON = "纯查询（GET 不写库）";

/** 构造后每条路由都带的元数据（已补缺省值） */
export interface RouteMeta {
  operationId: string;
  "x-auth": XAuth;
  /** 商家端、下载页的能力点；null = 不设能力点 */
  "x-capability"?: string | null;
  /** 后台的权限点；null = 不设权限点（公开路由、本人操作、按模块等级的查看类，约定 C66） */
  "x-permission"?: string | null;
  /** 只在商家端 */
  "x-clerk-view"?: ClerkView;
  "x-idempotent": XIdempotent;
  /** natural 时必填：承担去重的约束名 */
  "x-idempotent-by"?: readonly string[];
  /** none 时必填 */
  "x-idempotent-reason"?: string;
  /** 三段式用例（约定 C51） */
  "x-three-phase"?: true;
  /** 结果脱敏：幂等记录里要置空的字段路径（约定 C50），只用于 required */
  "x-redact-on-replay"?: readonly string[];
  /** 限流档位（约定 C68） */
  "x-rate-limit"?: string;
  /** 只用于约定 C86 登记的后台驳回接口 */
  "x-step-up"?: "skip";
}

/** 元数据里所有以 x- 开头的键 */
export const ROUTE_META_EXTENSION_KEYS = [
  "x-auth",
  "x-capability",
  "x-permission",
  "x-clerk-view",
  "x-idempotent",
  "x-idempotent-by",
  "x-idempotent-reason",
  "x-three-phase",
  "x-redact-on-replay",
  "x-rate-limit",
  "x-step-up",
] as const satisfies readonly (keyof RouteMeta)[];

/** 路由的版本：V1.1 的只登记，V1.0 不落地（07 第 1 节） */
export const ROUTE_VERSIONS = ["V1.0", "V1.1"] as const;
export type RouteVersion = (typeof ROUTE_VERSIONS)[number];

/**
 * 一条路由的归属：V1.0 的写里程碑（计划 第 5.7 节“实现进度”行；取值与 x01 条目的归属同一套，
 * 在 registry/define.ts 的 MILESTONES），V1.1 的写 V1.1（只登记）。数据在 milestones.ts
 */
export type RoutePlacement = Milestone | "V1.1";
