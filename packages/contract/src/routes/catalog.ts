// 路由清单（W0-10）：把三种登记形态规范化成同一种记录，一条路由一行，带所属文档、版本与归属的里程碑。
// 记录的字段名与 docs/api/working/routemap.json 相同，所以 pnpm contract:docs-check 可以逐字段直接比；
// 生成脚本把它写成 generated/routes.json，infra/ci 下不引依赖的脚本（待落地清单、计划 第 8.2 节的表、
// 约束名核对）只读那份 JSON（任务书 第 11 节第 9 项）。
import { isCapabilityKey, isPermissionKey, permissionByKey } from "../authz/index.js";

import { MILESTONES, type Milestone } from "../registry/define.js";

import type { AnyContractRoute, RegistryOnlyEntry } from "./builders.js";
import type { RouteDoc } from "./doc.js";
import type { MetaOnlyRoute } from "./meta-only.js";
import {
  API_PREFIX,
  ASSERT_IN_HANDLER,
  type ClerkView,
  type RoutePlacement,
  type RouteVersion,
  type XAuth,
  type XIdempotent,
} from "./meta.js";

export interface RouteCatalogEntry {
  /** 接口文档名，如 m01-account */
  doc: string;
  /** operationId；只登记的探活这里是登记键（只作清单编号） */
  operationId: string;
  /** 只登记的探活才有：不进 OpenAPI，不分配 operationId（约定 C1、C74） */
  registryKeyOnly?: true;
  /** 大写，同路线图 */
  method: string;
  /** 约定里的写法，不带 /api/v1 */
  path: string;
  summary: string | null;
  xAuth: XAuth;
  capability: string | null;
  permission: string | null;
  clerkView: ClerkView | null;
  xIdempotent: XIdempotent;
  idempotentBy: readonly string[] | null;
  /** x-idempotent-reason */
  idempotentNote: string | null;
  xStepUp?: "skip";
  /** 只靠网络隔离的内网探活：在公开路由的黄金文件里标“仅内网” */
  internalOnly?: true;
  version: RouteVersion;
  /** V1.0 的归属；V1.1 的为 null */
  milestone: Milestone | null;
  /** 有没有请求与响应的 Zod 结构：有才进 OpenAPI、才能挂处理器 */
  hasSchema: boolean;
}

type Placements = Readonly<Record<string, RoutePlacement>>;

function placementFields(
  key: string,
  placements: Placements,
): Pick<RouteCatalogEntry, "version" | "milestone"> {
  const placement = placements[key];
  // 没写归属的先按 V1.0、未定里程碑出清单，由 routeCatalogProblems 点名
  if (placement === undefined) return { version: "V1.0", milestone: null };
  return placement === "V1.1"
    ? { version: "V1.1", milestone: null }
    : { version: "V1.0", milestone: placement };
}

function fromRoute(
  doc: string,
  route: AnyContractRoute | MetaOnlyRoute,
  hasSchema: boolean,
  placements: Placements,
): RouteCatalogEntry {
  const stepUp = route["x-step-up"];
  return {
    doc,
    operationId: route.operationId,
    method: route.method.toUpperCase(),
    path: route.path.slice(API_PREFIX.length),
    summary: route.summary ?? null,
    xAuth: route["x-auth"],
    capability: route["x-capability"] ?? null,
    permission: route["x-permission"] ?? null,
    clerkView: route["x-clerk-view"] ?? null,
    xIdempotent: route["x-idempotent"],
    idempotentBy: route["x-idempotent-by"] ?? null,
    idempotentNote: route["x-idempotent-reason"] ?? null,
    ...(stepUp === undefined ? {} : { xStepUp: stepUp }),
    ...placementFields(route.operationId, placements),
    hasSchema,
  };
}

function fromProbe(
  doc: string,
  entry: RegistryOnlyEntry,
  placements: Placements,
): RouteCatalogEntry {
  return {
    doc,
    operationId: entry.registryKey,
    registryKeyOnly: true,
    method: entry.method.toUpperCase(),
    path: entry.path,
    summary: entry.summary ?? null,
    xAuth: entry["x-auth"],
    capability: null,
    permission: null,
    clerkView: null,
    xIdempotent: "none",
    idempotentBy: null,
    idempotentNote: null,
    ...(entry.internalOnly ? { internalOnly: true as const } : {}),
    ...placementFields(entry.registryKey, placements),
    hasSchema: false,
  };
}

/** 全部路由的清单：按文档的登记顺序，文档内按 operationId 排，与声明顺序无关 */
export function buildRouteCatalog(
  docs: readonly RouteDoc[],
  placements: Placements,
): RouteCatalogEntry[] {
  return docs.flatMap((doc) =>
    [
      ...doc.routes.map((route) => fromRoute(doc.doc, route, true, placements)),
      ...doc.metaOnly.map((route) => fromRoute(doc.doc, route, false, placements)),
      ...doc.registryOnly.map((entry) => fromProbe(doc.doc, entry, placements)),
    ].sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0)),
  );
}

/**
 * 清单有哪些问题（契约自测、生成脚本与 contract:docs-check 都调它；没有问题返回空数组）：
 *   - 每条路由都写了归属，归属表里没有多余的键；V1.0 的都有里程碑；
 *   - 权限点、能力点都在 @liyoxi/contract/authz 的注册表里（assert-in-handler 与不设放行，约定 C66、C75）；
 *   - V1.0 的路由不用 V1.1 才启用的权限点；
 *   - x-step-up: skip 只出现在驳回接口上（约定 C86）；与 C86 登记表的双向核对在 contract:docs-check。
 */
export function routeCatalogProblems(
  catalog: readonly RouteCatalogEntry[],
  placements: Placements,
): string[] {
  const problems: string[] = [];
  const keys = new Set(catalog.map((entry) => entry.operationId));
  for (const key of Object.keys(placements)) {
    if (!keys.has(key)) problems.push(`归属表里的 ${key} 不是登记过的路由（milestones.ts）`);
  }
  const milestones: readonly string[] = MILESTONES;
  for (const entry of catalog) {
    const id = entry.operationId;
    const placement = placements[id];
    if (placement === undefined) {
      problems.push(`${id} 没有写归属：在 milestones.ts 里给它一个里程碑，V1.1 的写 "V1.1"`);
    } else if (placement !== "V1.1" && !milestones.includes(placement)) {
      problems.push(`${id} 的归属 ${String(placement)} 不是 ${MILESTONES.join("、")} 或 V1.1`);
    }
    const { permission, capability } = entry;
    if (permission !== null && permission !== ASSERT_IN_HANDLER) {
      if (!isPermissionKey(permission)) {
        problems.push(`${id} 的权限点 ${permission} 不在权限点注册表里（authz/permissions）`);
      } else if (entry.version === "V1.0" && permissionByKey(permission)?.since === "v1.1") {
        problems.push(`${id} 是 V1.0 的路由，却用了 V1.1 才启用的权限点 ${permission}`);
      }
    }
    if (capability !== null && capability !== ASSERT_IN_HANDLER && !isCapabilityKey(capability)) {
      problems.push(`${id} 的能力点 ${capability} 不在能力点注册表里（authz/capabilities）`);
    }
    if (entry.xStepUp === "skip" && !/\.(reject|rejectReview)$/.test(id)) {
      problems.push(
        `${id} 声明了 x-step-up: skip，但它不是驳回接口（约定 C86：只用于 reject / reject-review）`,
      );
    }
  }
  return problems;
}
