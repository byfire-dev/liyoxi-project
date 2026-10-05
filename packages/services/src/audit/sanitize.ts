// 审计内容的清洗与截断（W0-14；D4 第 8.2 节第 2 条；03 分组 第 4 节）。record 的契约是“永不因内容格式失败”：
//   文本：去掉 NUL 与不成对的代理项（PostgreSQL 的 text、jsonb 都不收），按字数截断，超出以“…”结尾。
//   JSON：任意输入变成 jsonb 收得下的值；敏感键按 sensitive.ts 剔除或脱敏；序列化后超过 16KB 改存摘要。
// 这里的函数对任何输入都不抛错。
import { createHash } from "node:crypto";

import type { AuditJsonDigest } from "@liyoxi/contract";

import { sensitiveRule } from "./sensitive.js";

/** 各文本列的上限，单位是字（码点） */
export const AUDIT_TEXT_LIMITS = {
  summary: 200,
  targetLabel: 120,
  actorName: 32,
  actorRole: 32,
  reasonText: 500,
  userAgent: 512,
  // 下面几项依据文档没有定上限，这里给一个够用的：不让一个超长的值撑大索引与行
  reasonCode: 64,
  targetKey: 200,
  requestId: 128,
  ip: 64,
  jobName: 128,
} as const;
/** before、after、meta 序列化后的上限，字节 */
export const AUDIT_JSON_MAX_BYTES = 16 * 1024;
/** 嵌套超过这么多层的部分换成一句说明：PostgreSQL 解析太深的 JSON 会报栈深超限 */
export const AUDIT_JSON_MAX_DEPTH = 16;
const DIGEST_MAX_KEYS = 50;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** 带 u 标志：成对的代理项算一个码点，不命中；只匹配不成对的 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "";
  }
}

/** 去掉 NUL 与不成对的代理项 */
export const cleanText = (value: unknown): string =>
  toText(value).replaceAll("\u0000", "").replace(LONE_SURROGATE, "");

/** 清洗后截到 max 个字；超出的以“…”结尾，连“…”在内不超过 max */
export function clip(value: unknown, max: number): string {
  const text = cleanText(value);
  if (text.length <= max) return text;
  // 2 × max + 2 个码元里至少有 max + 1 个字，够判断超没超；不把整个超长串拆成数组
  const chars = Array.from(text.slice(0, max * 2 + 2));
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** 同 clip；null、undefined 给 null */
export const clipOrNull = (value: unknown, max: number): string | null =>
  value === null || value === undefined ? null : clip(value, max);

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** 敏感键下面的值：文本与数字脱敏；数组逐项脱敏；别的形状整个打码 */
function masked(mask: (value: string) => string, value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => masked(mask, item));
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return "****";
  }
  try {
    return cleanText(mask(cleanText(value)));
  } catch {
    return "****";
  }
}

/**
 * 把任意值变成 jsonb 收得下的值。undefined、函数、symbol 给 undefined（对象里略去，数组里写 null）。
 * @param mask 为 true 时按键名剔除、脱敏敏感键
 */
export function cleanJson(
  value: unknown,
  mask: boolean,
  depth = 0,
  seen = new Set<object>(),
): Json | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (!isPlain(value)) return undefined;
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
      return `[二进制 ${value.byteLength} 字节]`;
    if (depth >= AUDIT_JSON_MAX_DEPTH) return "[嵌套过深，略]";
    if (seen.has(value)) return "[循环引用，略]";
    seen.add(value);
    const next = (child: unknown): Json | undefined => cleanJson(child, mask, depth + 1, seen);
    let result: Json | undefined;
    if (Array.isArray(value) || value instanceof Set) {
      result = Array.from(value, (item) => next(item) ?? null);
    } else if (typeof value.toJSON === "function") {
      result = next(value.toJSON());
    } else {
      const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
      const cleaned: Array<[string, Json]> = [];
      for (const [rawKey, child] of entries) {
        const key = cleanText(rawKey);
        const rule = mask ? sensitiveRule(key) : undefined;
        if (rule === "drop") continue;
        const item = rule === undefined ? next(child) : masked(rule, child);
        if (item !== undefined) cleaned.push([key, item]);
      }
      // 键排好序：同样的内容序列化出来相同，求差时直接比文本。fromEntries 不会把 __proto__ 当原型设
      result = Object.fromEntries(cleaned.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    seen.delete(value);
    return result;
  } catch {
    // 取属性时抛错的对象（代理、会抛的 getter）
    return "[读不出，略]";
  }
}

/** 清洗成一个对象：不是对象的（数组、文本等）包一层 { value } */
export function cleanObject(value: unknown, mask: boolean): JsonObject {
  const cleaned = cleanJson(value, mask);
  const isObject = typeof cleaned === "object" && cleaned !== null && !Array.isArray(cleaned);
  return isObject ? cleaned : { value: cleaned ?? null };
}

/** 序列化后超过 16KB 的改存摘要：顶层键名（至多 50 个，各截到 64 字）、字节数、sha256 */
export function capJson(value: JsonObject | null): JsonObject | AuditJsonDigest | null {
  if (value === null) return null;
  const text = JSON.stringify(value);
  const length = Buffer.byteLength(text, "utf8");
  if (length <= AUDIT_JSON_MAX_BYTES) return value;
  return {
    keys: Object.keys(value)
      .slice(0, DIGEST_MAX_KEYS)
      .map((key) => clip(key, 64)),
    length,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}
