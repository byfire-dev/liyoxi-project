// 子路径 @liyoxi/shared/params：参数的定义（类型、单位、范围、默认值）与校验的纯函数（W0-18）。
//
// 依据：14 分组 第 2.3、4.2 节；接口文档 a01 第 2.13 节。键与分组的唯一来源是契约的参数键清单，
// 这里给每个键配一条定义。库里（param_value）只存值；读取、缓存、快照在 services 的 config 模块。
//
//   paramDef(key)            取一个键的定义
//   validateParamValue       按定义校验一个值
//   checkParamDefs           定义表自检：登记的键都有定义、默认值合自己的定义（启动时调，不过即启动失败）
//   checkParamPairs          成对的规则（起要早于止）

import { PARAM_KEYS } from "@liyoxi/contract/config/params";
import type { ParamKey } from "@liyoxi/contract/config/params";

import { validateParamValue } from "./define.js";
import type { ParamDef, ParamValueOfDef } from "./define.js";
import { PARAM_DEFS, PARAM_PAIR_RULES } from "./defs.js";

export * from "./define.js";
export * from "./defs.js";

type Defs = (typeof PARAM_DEFS)[number];
/** 有定义的键 */
export type DefinedParamKey = Defs["key"];
/** 一个键的值类型，如 ParamValue<"work.start"> 是 string */
export type ParamValue<K extends DefinedParamKey> = ParamValueOfDef<Extract<Defs, { key: K }>>;

// 编译期核对：契约登记的键都有定义。少一条定义，下面这一行类型检查不过，报出缺的是哪个键。
type MissingDefs = Exclude<ParamKey, DefinedParamKey>;
const everyRegisteredKeyIsDefined: [MissingDefs] extends [never] ? true : MissingDefs = true;
void everyRegisteredKeyIsDefined;

const BY_KEY: ReadonlyMap<string, ParamDef> = new Map(
  (PARAM_DEFS as readonly ParamDef[]).map((def) => [def.key, def]),
);

/** 取一个键的定义；没有定义返回 undefined */
export function paramDef(key: string): ParamDef | undefined {
  return BY_KEY.get(key);
}

/** 定义表的一个问题 */
export interface ParamDefIssue {
  key: string;
  problem: string;
}

/**
 * 定义表自检。registered 缺省取契约的清单；defs 缺省取本包的定义表（两个参数只为用例能造反例）。
 * 查三件事：登记的键都有定义；定义不重复；每条定义的默认值合它自己的类型与范围。
 * 定义了、清单里却没有的键不算问题：那是先写了定义、登记还没合进来，读取一侧够不着它。
 */
export function checkParamDefs(
  registered: readonly string[] = PARAM_KEYS.map((item) => item.key),
  defs: readonly ParamDef[] = PARAM_DEFS,
): ParamDefIssue[] {
  const issues: ParamDefIssue[] = [];
  const seen = new Set<string>();
  for (const def of defs) {
    if (seen.has(def.key)) issues.push({ key: def.key, problem: "定义重复" });
    seen.add(def.key);
    const problem = validateParamValue(def, def.default);
    if (problem !== null) issues.push({ key: def.key, problem: `默认值不合定义：${problem}` });
  }
  for (const key of registered) {
    if (!seen.has(key)) issues.push({ key, problem: "参数缺定义" });
  }
  return issues;
}

/**
 * 成对的规则：给出各键的值（没给的键不查），返回不满足的规则说明。
 * HH:mm 定宽，直接按字符串比。
 */
export function checkParamPairs(values: Readonly<Record<string, unknown>>): string[] {
  return PARAM_PAIR_RULES.filter(({ start, end }) => {
    const from = values[start];
    const to = values[end];
    return typeof from === "string" && typeof to === "string" && from >= to;
  }).map((rule) => rule.label);
}
