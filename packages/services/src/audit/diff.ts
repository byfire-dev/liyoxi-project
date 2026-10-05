// 求差（W0-14；D4 第 8.2 节；任务书 第 11 节第 4 项）：调用方传整对象与字段白名单，这里只留变化的字段并脱敏。
// 比的是脱敏之前的值：两个不同的手机号脱敏后可能一样，不能拿脱敏串去比。
import { cleanJson, cleanObject, cleanText } from "./sanitize.js";
import type { Json, JsonObject } from "./sanitize.js";
import { sensitiveRule } from "./sensitive.js";

export interface FieldDiff {
  /** 变更前：只含变化的字段；新建（before 不是对象）或没有变化时为 null */
  readonly before: JsonObject | null;
  /** 变更后：同上；删除（after 不是对象）或没有变化时为 null */
  readonly after: JsonObject | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 只取对象自己的属性：__proto__、constructor 这类继承来的不算字段 */
function pick(source: unknown, field: string): unknown {
  try {
    return isObject(source) && Object.hasOwn(source, field) ? source[field] : undefined;
  } catch {
    return undefined;
  }
}

/** 清洗一个字段的值。包一层再清洗：字段自己的键名、它里面各层的键名都按敏感键处理 */
const maskedValue = (key: string, raw: unknown): Json =>
  Object.values(cleanObject(Object.fromEntries([[key, raw]]), true))[0] ?? null;

/**
 * 按白名单求差。白名单之外的字段不看；白名单里命中“剔除”的敏感键（口令、令牌等）也不记。
 * 缺这个字段与值为 null 当作相同。比的是清洗之后的值：嵌套超过上限的部分已经换成说明，那里面的差别看不出来。
 */
export function diffFields(before: unknown, after: unknown, fields: readonly string[]): FieldDiff {
  const changedBefore: Array<[string, Json]> = [];
  const changedAfter: Array<[string, Json]> = [];
  for (const field of new Set(fields)) {
    const key = cleanText(field);
    if (sensitiveRule(key) === "drop") continue;
    const [rawBefore, rawAfter] = [pick(before, field), pick(after, field)];
    const same =
      JSON.stringify(cleanJson(rawBefore, false) ?? null) ===
      JSON.stringify(cleanJson(rawAfter, false) ?? null);
    if (same) continue;
    changedBefore.push([key, maskedValue(key, rawBefore)]);
    changedAfter.push([key, maskedValue(key, rawAfter)]);
  }
  const changed = changedAfter.length > 0;
  // fromEntries 不会把 __proto__ 这样的键名当原型设
  return {
    before: changed && isObject(before) ? Object.fromEntries(changedBefore) : null,
    after: changed && isObject(after) ? Object.fromEntries(changedAfter) : null,
  };
}
