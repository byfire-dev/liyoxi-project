// 开关求值（W0-18）。依据：14 分组 第 2.7、4.6 节；D6 第 4.4 节；D7 第 3.2 节；约定 C70、C71。
//
// 键、值类型、默认值登记在契约（@liyoxi/contract 的 FLAGS）；库里（feature_flag）的行可以改默认值、加规则。
// 求值：按序找第一条命中的规则，没有命中取默认值。库里没有这一行（还没播种）即用登记的默认值。
// 规则的条件只有平台、客户端版本、环境、主体白名单四种；不按审核身份、IP、账号区分（约定 C70）。
// 开关是提示不是防线：受开关控制的路由服务端同样拦，守卫调 requireEnabled，关着即 403 FEATURE_DISABLED。
// 引导接口下发 forClient 的结果；服务端守卫用同一个函数、同一个上下文再算一遍。
import { flagByKey, FLAGS, FlagRulesSchema, isFlagValueOfType } from "@liyoxi/contract";
import type { ClientFlagKey, EnvVersion, FlagKey, FlagRule, FlagValue } from "@liyoxi/contract";

import { AppError } from "../kernel/index.js";

import type { ConfigCache } from "./cache.js";
import type { ConfigDb, ConfigProblem, ConfigReport } from "./types.js";
import { matchesVersionRange, parseVersion } from "./version.js";

/** 求值的上下文：取自请求头 X-Client-Platform、X-Client-Version、X-Env-Version 与当前主体 */
export interface FlagContext {
  platform?: string | null;
  clientVersion?: string | null;
  envVersion?: EnvVersion | null;
  entityId?: string | null;
}

export interface Flags {
  /** 全部开关按上下文求值 */
  evaluate(context?: FlagContext): Promise<Record<FlagKey, FlagValue>>;
  /** 只有下发给前端的开关（exposed_to = client）：引导接口的 flags */
  forClient(context?: FlagContext): Promise<Record<ClientFlagKey, FlagValue>>;
  /** 一个开关的求值结果 */
  value(key: FlagKey, context?: FlagContext): Promise<FlagValue>;
  /** 布尔开关开没开。拿不是布尔的开关来问即抛 TypeError */
  isEnabled(key: FlagKey, context?: FlagContext): Promise<boolean>;
  /** 路由与用例的守卫：开关关着即抛 AppError("FEATURE_DISABLED")（HTTP 403） */
  requireEnabled(key: FlagKey, context?: FlagContext): Promise<void>;
  /** 最低客户端版本：开关 client.min_version 的求值结果（约定 C71）；不是合法版本号时取 0.0.0 */
  minClientVersion(context?: FlagContext): Promise<string>;
  /** 自检：库里的行逐行对登记，返回问题清单（config.N19） */
  selfCheck(): Promise<ConfigProblem[]>;
}

export interface FlagsOptions {
  db: ConfigDb;
  cache: ConfigCache;
  report?: ConfigReport;
}

interface Effective {
  defaultValue: FlagValue;
  rules: readonly FlagRule[];
}
type FlagState = ReadonlyMap<string, Effective>;

interface FlagRow {
  key: string;
  valueType: string;
  defaultValue: unknown;
  rules: unknown;
}

/** 一条规则命不命中：写了的条件都满足才算；上下文里缺的那一项当不满足 */
export function matchesRule(when: FlagRule["when"], context: FlagContext): boolean {
  const { platform, clientVersion, envVersion, entityIds } = when;
  if (platform && !(context.platform && platform.includes(context.platform))) return false;
  if (clientVersion !== undefined && !matchesVersionRange(context.clientVersion, clientVersion)) {
    return false;
  }
  if (envVersion && !(context.envVersion && envVersion.includes(context.envVersion))) return false;
  if (entityIds && !(context.entityId && entityIds.includes(context.entityId))) return false;
  return true;
}

/** 库里的一行对登记：能用就给出生效的默认值与规则，不能用给出问题 */
function interpret(row: FlagRow): Effective | ConfigProblem {
  const problem = (kind: ConfigProblem["kind"], detail: string): ConfigProblem => ({
    kind,
    subject: row.key,
    detail,
  });
  const def = flagByKey(row.key);
  if (!def) return problem("flag_unknown_key", "库里的开关键没有登记");
  if (row.valueType !== def.valueType) {
    return problem("flag_invalid_row", `值类型是 ${row.valueType}，登记的是 ${def.valueType}`);
  }
  if (!isFlagValueOfType(def.valueType, row.defaultValue)) {
    return problem("flag_invalid_row", "默认值不合值类型");
  }
  const rules = FlagRulesSchema.safeParse(row.rules);
  if (!rules.success) return problem("flag_invalid_row", "规则不合结构");
  if (!rules.data.every((rule) => isFlagValueOfType(def.valueType, rule.value))) {
    return problem("flag_invalid_row", "规则的值不合值类型");
  }
  return { defaultValue: row.defaultValue, rules: rules.data };
}

const isProblem = (value: Effective | ConfigProblem): value is ConfigProblem => "kind" in value;

export function createFlags(options: FlagsOptions): Flags {
  const { db, cache, report } = options;
  const select = { key: true, valueType: true, defaultValue: true, rules: true } as const;

  async function load() {
    const rows = await db.featureFlag.findMany({ select });
    const usable = new Map<string, Effective>();
    for (const row of rows) {
      const result = interpret(row);
      if (isProblem(result)) report?.(result);
      else usable.set(row.key, result);
    }
    const data = new Map<string, Effective>();
    for (const def of FLAGS) {
      // 没有行、或这一行不能用：取登记的默认值，不带规则
      data.set(def.key, usable.get(def.key) ?? { defaultValue: def.defaultValue, rules: [] });
    }
    return { data: data as FlagState };
  }

  const state = (): Promise<FlagState> => cache.read("flag", load);

  function evaluateOne(flags: FlagState, key: FlagKey, context: FlagContext): FlagValue {
    const flag = flags.get(key);
    if (!flag) throw new TypeError(`开关 ${String(key)} 没有登记`);
    const hit = flag.rules.find((rule) => matchesRule(rule.when, context));
    return hit ? (hit.value as FlagValue) : flag.defaultValue;
  }

  async function evaluate(context: FlagContext = {}): Promise<Record<FlagKey, FlagValue>> {
    const flags = await state();
    return Object.fromEntries(
      FLAGS.map((def) => [def.key, evaluateOne(flags, def.key, context)]),
    ) as Record<FlagKey, FlagValue>;
  }

  async function value(key: FlagKey, context: FlagContext = {}): Promise<FlagValue> {
    return evaluateOne(await state(), key, context);
  }

  async function isEnabled(key: FlagKey, context: FlagContext = {}): Promise<boolean> {
    if (flagByKey(key)?.valueType !== "bool") {
      throw new TypeError(`开关 ${String(key)} 不是布尔开关，不能问开没开`);
    }
    return (await value(key, context)) === true;
  }

  return {
    evaluate,
    value,
    isEnabled,

    async forClient(context = {}) {
      const all = await evaluate(context);
      return Object.fromEntries(
        FLAGS.filter((def) => def.exposedTo === "client").map((def) => [def.key, all[def.key]]),
      ) as Record<ClientFlagKey, FlagValue>;
    },

    async requireEnabled(key, context = {}) {
      if (!(await isEnabled(key, context))) throw new AppError("FEATURE_DISABLED");
    },

    async minClientVersion(context = {}) {
      const version = await value("client.min_version", context);
      return typeof version === "string" && parseVersion(version) ? version : "0.0.0";
    },

    async selfCheck() {
      const rows = await db.featureFlag.findMany({ select });
      return rows.map(interpret).filter(isProblem);
    },
  };
}
