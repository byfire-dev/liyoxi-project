// 幂等键的格式与请求哈希（W0-13）：纯函数，不连库。
// 依据：约定 第 3 节（Idempotency-Key 的格式）、第 7 节 C49（request_hash 的口径）；01 分组 第 2.1 节（十六进制小写 64 位）。
// “规范化”文档只写了这五个字，口径由任务书 第 11 节第 1 项定：对象的键排序、去掉值为 undefined 的键、数组顺序不变，再序列化。
import { createHash } from "node:crypto";

/** Idempotency-Key：1–128 个字符，字符集 [A-Za-z0-9:_-]。库里 ck_idempotency_record_key 是同一条 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

export const isIdempotencyKey = (value: unknown): value is string =>
  typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);

/**
 * 规范化后的 JSON 文本：键顺序不同的等价内容得到同一个字符串。
 * 其余照 JSON.stringify 的规矩：值为 undefined 的键去掉，数组里的 undefined 写成 null，Date 走 toJSON，BigInt 抛 TypeError。
 * 键的次序只由键的集合决定（先排序再重建对象），所以与写入时的先后无关。
 */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    const source = inner as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, source[key]]),
    );
  });
  return text ?? "null";
}

export interface RequestHashInput {
  /** HTTP 方法，大小写不论；系统任务可以写任务自己定的动词 */
  method: string;
  /** 路径参数：名 → 值。按名排序后计入 */
  pathParams?: Readonly<Record<string, string>>;
  /** 请求体；没有就不给 */
  body?: unknown;
  /** 商家端的 X-Store-Id：同一个键在不同门店上下文下视为不同请求（A121）。后台、下载页、系统任务不给 */
  storeId?: string | null;
}

/** request_hash = sha256(方法 + 路径参数 + 规范化后的请求体 [+ X-Store-Id])，十六进制小写 64 位 */
export function requestHash(input: RequestHashInput): string {
  const { method, pathParams = {}, body = null, storeId = null } = input;
  // 四段放进一个数组再序列化：段与段之间的边界由 JSON 自己分清，不会因为拼接而撞
  const material = canonicalJson([method.toUpperCase(), pathParams, body, storeId]);
  return createHash("sha256").update(material).digest("hex");
}
