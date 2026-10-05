// 参数定义的形态与校验（W0-18）。依据：14 分组 第 2.3、4.2 节；D6 第 4.2.1 节；接口文档 a01 第 2.13 节。
//
// 定义在代码里，库里（param_value）只存值。一个键一条定义：类型、单位、范围、默认值、何时快照。
// 所属分组不在定义里：分组的唯一来源是契约的参数键清单（@liyoxi/contract/config/params）。
// 纯函数：本目录不带 Zod，json 类型的校验写成 check 函数（返回问题说明，没问题返回 null）。

import type { SlaPolicy } from "../workcal/index.js";

/** 参数类型（14 分组 第 4.2 节）。值的 JSON 形态由它决定 */
export type ParamType =
  "int" | "bp" | "int_list" | "time_hm" | "bool" | "enum" | "text" | "json" | "sla_policy";

/** 何时取值：create 单据创建时快照，之后产生的单据才按新值；read 每次读当前值 */
export type ParamSnapshotOn = "create" | "read";

export type SlaUnit = SlaPolicy["unit"];
export const SLA_UNITS: readonly SlaUnit[] = [
  "work_minutes",
  "work_days",
  "natural_hours",
  "natural_days",
  "same_day_cutoff",
];

/**
 * 一条参数定义。V 是值的类型；D 是默认值的类型：默认值为 null 的键“不设”，
 * 库里没有值时读到 null，库里也可以存 null（撤掉曾经设过的值）。
 */
export interface ParamDef<K extends string = string, V = unknown, D = V | null> {
  readonly key: K;
  readonly type: ParamType;
  /** 显示名 */
  readonly label: string;
  /** 单位，如“天”“分钟”；没有为 null */
  readonly unit: string | null;
  /** 代码默认值，也是“恢复默认值”的回填值 */
  readonly default: D;
  readonly snapshotOn: ParamSnapshotOn;
  /** int、bp 的取值范围；int_list 是每个元素的范围；sla_policy 是 amount 的范围（same_day_cutoff 除外） */
  readonly min?: number;
  readonly max?: number;
  /** int_list 的个数范围；text 的字数上限 */
  readonly minLength?: number;
  readonly maxLength?: number;
  /** int_list 的次序：desc 严格递减，asc 严格递增 */
  readonly order?: "asc" | "desc";
  /** enum 的取值 */
  readonly options?: readonly string[];
  /** sla_policy 允许的单位；不写即五种都行 */
  readonly units?: readonly SlaUnit[];
  /** json 的结构校验：返回问题说明，没问题返回 null */
  readonly check?: (value: unknown) => string | null;
  /** 值里的敏感路径（元素的字段名）：出接口只给脱敏串 */
  readonly sensitivePaths?: readonly string[];
  /** 补充说明 */
  readonly description?: string;
  /** 只在类型上带着值的类型，运行时没有这个字段 */
  readonly __value?: V;
}

/** 定义对应的值类型：默认值为 null 的键读出来可能是 null */
export type ParamValueOfDef<Def> =
  Def extends ParamDef<string, infer V, infer D> ? (null extends D ? V | null : V) : never;

interface Common {
  unit?: string;
  snapshotOn?: ParamSnapshotOn;
  description?: string;
}

const base = (options: Common) => ({
  unit: options.unit ?? null,
  snapshotOn: options.snapshotOn ?? "read",
  ...(options.description === undefined ? {} : { description: options.description }),
});

/** 整数。min、max 必填：没有范围的整数参数等于没有校验 */
export function int<const K extends string, const D extends number | null>(
  key: K,
  label: string,
  options: Common & { default: D; min: number; max: number },
): ParamDef<K, number, D> {
  const { default: fallback, min, max } = options;
  return { key, type: "int", label, default: fallback, min, max, ...base(options) };
}

/** 整数列表，如提醒节点 */
export function intList<const K extends string>(
  key: K,
  label: string,
  options: Common & {
    default: readonly number[];
    min: number;
    max: number;
    minLength: number;
    maxLength: number;
    order?: "asc" | "desc";
  },
): ParamDef<K, readonly number[], readonly number[]> {
  const { default: fallback, min, max, minLength, maxLength, order } = options;
  return {
    key,
    type: "int_list",
    label,
    default: fallback,
    min,
    max,
    minLength,
    maxLength,
    ...(order === undefined ? {} : { order }),
    ...base(options),
  };
}

/** 时刻 HH:mm（00:00–23:59） */
export function timeHm<const K extends string>(
  key: K,
  label: string,
  options: Common & { default: string },
): ParamDef<K, string, string> {
  return { key, type: "time_hm", label, default: options.default, ...base(options) };
}

export function bool<const K extends string>(
  key: K,
  label: string,
  options: Common & { default: boolean },
): ParamDef<K, boolean, boolean> {
  return { key, type: "bool", label, default: options.default, ...base(options) };
}

export function enumOf<const K extends string, const O extends readonly [string, ...string[]]>(
  key: K,
  label: string,
  options: Common & { options: O; default: O[number] },
): ParamDef<K, O[number], O[number]> {
  return {
    key,
    type: "enum",
    label,
    default: options.default,
    options: options.options,
    ...base(options),
  };
}

/** 时限策略 { amount, unit }。sla.* 键一律是它 */
export function slaPolicy<const K extends string, const D extends SlaPolicy | null>(
  key: K,
  label: string,
  options: Common & { default: D; units?: readonly SlaUnit[]; min?: number; max?: number },
): ParamDef<K, SlaPolicy, D> {
  const { default: fallback, units, min, max } = options;
  return {
    key,
    type: "sla_policy",
    label,
    default: fallback,
    min: min ?? 1,
    max: max ?? SLA_AMOUNT_MAX,
    ...(units === undefined ? {} : { units }),
    ...base({ ...options, snapshotOn: options.snapshotOn ?? "create" }),
  };
}

/** 任意 JSON，结构由 check 把关 */
export function json<const K extends string, V, const D extends V | null = V>(
  key: K,
  label: string,
  options: Common & {
    default: D;
    check: (value: unknown) => string | null;
    sensitivePaths?: readonly string[];
  },
): ParamDef<K, V, D> {
  const { default: fallback, check, sensitivePaths } = options;
  return {
    key,
    type: "json",
    label,
    default: fallback,
    check,
    ...(sensitivePaths === undefined ? {} : { sensitivePaths }),
    ...base(options),
  };
}

/** 时限数量的上限：只为挡住明显写错的值（多敲了几个零） */
export const SLA_AMOUNT_MAX = 100_000;
const MINUTES_PER_DAY = 1_440;
const HOUR_MINUTE = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const inRange = (value: number, def: ParamDef): boolean =>
  (def.min === undefined || value >= def.min) && (def.max === undefined || value <= def.max);

const rangeText = (def: ParamDef): string => `${String(def.min)}–${String(def.max)}`;

function checkIntList(def: ParamDef, value: unknown): string | null {
  if (!Array.isArray(value) || !value.every(isInt)) return "要一个整数数组";
  const list = value as number[];
  const { minLength = 0, maxLength = Number.MAX_SAFE_INTEGER, order } = def;
  if (list.length < minLength || list.length > maxLength) {
    return `个数要在 ${String(minLength)}–${String(maxLength)} 之间`;
  }
  if (!list.every((item) => inRange(item, def))) return `每一项要在 ${rangeText(def)} 之间`;
  const ordered = list.every((item, index) => {
    const previous = list[index - 1];
    if (previous === undefined || order === undefined) return true;
    return order === "desc" ? item < previous : item > previous;
  });
  return ordered ? null : order === "desc" ? "要从大到小排列，不重复" : "要从小到大排列，不重复";
}

function checkSlaPolicy(def: ParamDef, value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "要 { amount, unit }";
  }
  const { amount, unit, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return "只能有 amount、unit 两个键";
  const units = def.units ?? SLA_UNITS;
  if (typeof unit !== "string" || !(units as readonly string[]).includes(unit)) {
    return `unit 只能是 ${units.join("、")}`;
  }
  if (!isInt(amount)) return "amount 要是整数";
  if (unit === "same_day_cutoff") {
    // 截止时刻距零点的分钟数：1（00:01）到 1440（24:00）
    return amount >= 1 && amount <= MINUTES_PER_DAY ? null : "截止时刻要在 1–1440 分钟之间";
  }
  return inRange(amount, def) ? null : `amount 要在 ${rangeText(def)} 之间`;
}

/**
 * 按定义校验一个值。返回问题说明；合规返回 null。
 * 值为 null：只有默认值是 null 的键（“不设”）才接受。
 */
export function validateParamValue(def: ParamDef, value: unknown): string | null {
  if (value === null) return def.default === null ? null : "不能为空";
  switch (def.type) {
    case "int":
    case "bp":
      if (!isInt(value)) return "要一个整数";
      return inRange(value, def) ? null : `要在 ${rangeText(def)} 之间`;
    case "int_list":
      return checkIntList(def, value);
    case "time_hm":
      return typeof value === "string" && HOUR_MINUTE.test(value) ? null : "要 HH:mm";
    case "bool":
      return typeof value === "boolean" ? null : "要 true 或 false";
    case "enum":
      return typeof value === "string" && (def.options ?? []).includes(value)
        ? null
        : `只能是 ${(def.options ?? []).join("、")}`;
    case "text":
      if (typeof value !== "string" || value.trim() === "") return "要一段文字";
      return def.maxLength === undefined || [...value].length <= def.maxLength
        ? null
        : `不超过 ${String(def.maxLength)} 个字`;
    case "sla_policy":
      return checkSlaPolicy(def, value);
    case "json":
      return def.check ? def.check(value) : null;
  }
}
