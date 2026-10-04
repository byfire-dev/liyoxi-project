// 路由声明的把关（约定 C12、C14、C24、C47、C75）。只做判断，不依赖 Zod：
// 构造器与登记入口都调它；之后“只有元数据、没有结构”的登记形态（W0-10）也可以直接调。
import { HTTP_STATUSES } from "../errors/index.js";
import {
  CLERK_VIEWS,
  GROUP_AUTH,
  OPERATION_ID_PATTERN,
  ROUTE_METHODS,
  X_IDEMPOTENT_VALUES,
  type RouteGroup,
} from "./meta.js";

export interface RouteCheckInput {
  group: RouteGroup;
  method: string;
  /** 约定里的写法，不带 /api/v1，如 /m/orders/{orderId} */
  path: string;
  /** 元数据：operationId 与各个 x- 键。缺省值由构造器先补好 */
  meta: Readonly<Record<string, unknown>>;
  /** responses 的键；回调的应答按 Provider 协议，不查 */
  responseStatuses?: readonly string[];
  /** request.params 的键；没有声明 params 传 null；不查传 undefined */
  paramKeys?: readonly string[] | null;
}

const LITERAL_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARAM_SEGMENT = /^\{([a-z][A-Za-z0-9]*)\}$/;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isNonEmptyStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
const includes = (values: readonly unknown[], value: unknown) => values.includes(value);

/** 路径里的参数名，按出现顺序 */
export function pathParamNames(path: string): string[] {
  return path
    .split("/")
    .map((segment) => PARAM_SEGMENT.exec(segment)?.[1])
    .filter((name): name is string => name !== undefined);
}

function pathProblems(group: RouteGroup, path: string): string[] {
  if (!path.startsWith(`/${group}/`)) {
    return [`路径 ${path} 须以 /${group}/ 开头（写法同约定，不带 /api/v1）`];
  }
  const bad = path
    .split("/")
    .slice(1)
    .filter((segment) => !LITERAL_SEGMENT.test(segment) && !PARAM_SEGMENT.test(segment));
  return bad.length > 0
    ? [`路径 ${path} 的段 ${bad.map((s) => `“${s}”`).join("、")} 须为短横线小写或 {驼峰参数}`]
    : [];
}

function authProblems(group: RouteGroup, meta: RouteCheckInput["meta"]): string[] {
  const problems: string[] = [];
  const allowed: readonly string[] = GROUP_AUTH[group].allowed;
  if (!includes(allowed, meta["x-auth"])) {
    problems.push(`x-auth 须为 ${allowed.join(" / ")} 之一，现为 ${String(meta["x-auth"])}`);
  }
  const forbid = (key: string, where: string) => {
    if (meta[key] !== undefined) problems.push(`${key} 只用于${where}`);
  };
  const pointProblem = (key: string) => {
    const value = meta[key];
    if (value !== null && value !== undefined && !isNonEmptyString(value)) {
      problems.push(`${key} 须为非空字符串或 null`);
    }
  };
  if (group === "m") {
    if (!includes(CLERK_VIEWS, meta["x-clerk-view"])) {
      problems.push(`商家端路由须声明 x-clerk-view（${CLERK_VIEWS.join(" / ")}）`);
    }
  } else {
    forbid("x-clerk-view", "商家端");
  }
  if (group === "m" || group === "portal") pointProblem("x-capability");
  else forbid("x-capability", "商家端与下载页");
  if (group === "admin") {
    if (meta["x-permission"] === undefined) {
      problems.push(
        "后台路由须声明 x-permission：权限点、assert-in-handler，或 null（不设权限点）",
      );
    }
    pointProblem("x-permission");
    if (meta["x-step-up"] !== undefined) {
      if (meta["x-step-up"] !== "skip") problems.push("x-step-up 只能取 skip");
      if (!isNonEmptyString(meta["x-permission"])) {
        problems.push("x-step-up: skip 的路由须有权限点");
      }
    }
  } else {
    forbid("x-permission", "后台");
    forbid("x-step-up", "后台");
  }
  return problems;
}

function idempotencyProblems(method: string, meta: RouteCheckInput["meta"]): string[] {
  const problems: string[] = [];
  const mode = meta["x-idempotent"];
  if (method === "get") {
    if (mode !== "none") problems.push("GET 不写库，x-idempotent 只能是 none");
  } else if (mode === undefined) {
    problems.push(`写路由须声明 x-idempotent（${X_IDEMPOTENT_VALUES.join(" / ")}），没有缺省`);
  } else if (!includes(X_IDEMPOTENT_VALUES, mode)) {
    problems.push(`x-idempotent 须为 ${X_IDEMPOTENT_VALUES.join(" / ")} 之一`);
  }
  if (mode === "natural") {
    if (!isNonEmptyStringArray(meta["x-idempotent-by"])) {
      problems.push("x-idempotent: natural 须同时写出 x-idempotent-by（约束名的字符串数组）");
    }
  } else if (meta["x-idempotent-by"] !== undefined) {
    problems.push("x-idempotent-by 只用于 x-idempotent: natural");
  }
  if (mode === "none" && !isNonEmptyString(meta["x-idempotent-reason"])) {
    problems.push("x-idempotent: none 须写理由 x-idempotent-reason");
  }
  if (meta["x-redact-on-replay"] !== undefined) {
    if (mode !== "required") problems.push("x-redact-on-replay 只用于 x-idempotent: required");
    if (!isNonEmptyStringArray(meta["x-redact-on-replay"])) {
      problems.push("x-redact-on-replay 须为字段路径的字符串数组");
    }
  }
  return problems;
}

/** 一条路由的声明有哪些问题；没有问题返回空数组 */
export function routeProblems(input: RouteCheckInput): string[] {
  const { group, method, path, meta } = input;
  const problems: string[] = [];
  const operationId = meta.operationId;
  if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
    problems.push(
      `operationId ${String(operationId)} 不合约定 C14：<组>.<资源单数驼峰>[.<子资源>].<动作驼峰>`,
    );
  } else if (!operationId.startsWith(`${group}.`)) {
    problems.push(`operationId ${operationId} 的第一段须为 ${group}`);
  }
  if (!includes(ROUTE_METHODS, method)) {
    problems.push(`方法须为 ${ROUTE_METHODS.join(" / ")} 之一，现为 ${method}`);
  }
  problems.push(...pathProblems(group, path));
  problems.push(...authProblems(group, meta));
  problems.push(...idempotencyProblems(method, meta));
  if (meta["x-three-phase"] !== undefined && meta["x-three-phase"] !== true) {
    problems.push("x-three-phase 只能取 true");
  }
  if (meta["x-rate-limit"] !== undefined && !isNonEmptyString(meta["x-rate-limit"])) {
    problems.push("x-rate-limit 须为非空的档位名");
  }
  if (input.responseStatuses && group !== "hooks") {
    const allowed: readonly string[] = HTTP_STATUSES.map(String);
    const bad = input.responseStatuses.filter((status) => !allowed.includes(status));
    if (bad.length > 0) {
      problems.push(`HTTP 状态 ${bad.join("、")} 不在约定 C24 之内（不用 201、204、422）`);
    }
  }
  if (input.paramKeys !== undefined) {
    const inPath = pathParamNames(path).sort().join(",");
    const declared = [...(input.paramKeys ?? [])].sort().join(",");
    if (inPath !== declared) {
      problems.push(
        `路径参数 {${inPath}} 与 request.params 的键 {${declared}} 不一致：路径里的参数须逐个声明`,
      );
    }
  }
  return problems;
}
