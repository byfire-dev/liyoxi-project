import { isDeepStrictEqual } from "node:util";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { canonicalJson, isIdempotencyKey, requestHash } from "./request-hash.js";

// 验收第 6 条（甲类的性质测试）：键顺序不同的等价请求体哈希相同；内容不同哈希不同；X-Store-Id 不同哈希不同；
// 输出是 64 位小写十六进制。轮次与种子的约定同 ids.property.test.ts：PR 上固定种子、每个性质 200 轮；加大或复现用环境变量，例：
//   LYX_FC_RUNS=5000 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/kernel/request-hash.property.test.ts
// 失败时把反例固化成文件末尾的固定用例再修。
const runs = {
  numRuns: Number(process.env.LYX_FC_RUNS ?? 200),
  seed: Number(process.env.LYX_FC_SEED ?? 20261005),
};

const HEX64 = /^[0-9a-f]{64}$/;
/** 另用 shasum 算的：sha256('["POST",{"orderId":"o-1"},{"qty":2,"sku":"A"},"s-1"]') */
const KNOWN = "dc1c652d03fb5302989cbd0ebea3fcf71c81a52f30ee43c5b9a7197b59a3906c";
const body = fc.jsonValue({ maxDepth: 4 });
const post = (value: unknown, storeId?: string): string =>
  requestHash({ method: "POST", pathParams: { orderId: "o-1" }, body: value, storeId });

/** 把每一层对象的键换个次序重建（数组顺序不动）：salt 不同，次序不同 */
function reorder(value: unknown, salt: number): unknown {
  if (Array.isArray(value)) return value.map((item) => reorder(item, salt));
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const weight = (key: string): number =>
    [...key].reduce((sum, char) => (sum * 31 + char.charCodeAt(0) + salt) % 9973, salt % 9973);
  const keys = Object.keys(source).sort((a, b) => weight(a) - weight(b) || (a < b ? 1 : -1));
  const rebuilt: Record<string, unknown> = {};
  // defineProperty：键名是 __proto__ 时也当普通的键建，不去改原型
  for (const key of keys) {
    Object.defineProperty(rebuilt, key, {
      value: reorder(source[key], salt),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return rebuilt;
}

/** 两份请求体作为 JSON 是不是同一份内容（键的次序不算，-0 与 0 不分，undefined 的键不算） */
const sameJson = (a: unknown, b: unknown): boolean =>
  isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

describe("请求哈希：性质", () => {
  it("输出是 64 位小写十六进制", () => {
    fc.assert(
      fc.property(body, fc.option(fc.string(), { nil: undefined }), (value, storeId) => {
        expect(post(value, storeId)).toMatch(HEX64);
      }),
      runs,
    );
  });

  it("键顺序不同的等价请求体哈希相同", () => {
    fc.assert(
      fc.property(body, fc.nat(), fc.nat(), (value, saltA, saltB) => {
        const a = reorder(value, saltA);
        const b = reorder(value, saltB);
        expect(sameJson(a, b)).toBe(true);
        expect(post(a)).toBe(post(value));
        expect(post(b)).toBe(post(a));
      }),
      runs,
    );
  });

  it("内容不同哈希不同，内容相同哈希相同", () => {
    fc.assert(
      fc.property(body, body, (a, b) => {
        expect(post(a) === post(b)).toBe(sameJson(a, b));
      }),
      runs,
    );
    // 随机的两份几乎总是不同：另从同一份出发改一处，逼着它比“只差一点”的内容
    fc.assert(
      fc.property(fc.dictionary(fc.string(), body), fc.string(), body, (base, key, value) => {
        const changed = { ...base, [key]: value };
        expect(post(base) === post(changed)).toBe(sameJson(base, changed));
      }),
      runs,
    );
  });

  it("X-Store-Id、方法、路径参数任一不同，哈希不同；路径参数的书写次序不影响", () => {
    fc.assert(
      fc.property(body, fc.uuid(), fc.uuid(), (value, storeA, storeB) => {
        fc.pre(storeA !== storeB);
        expect(post(value, storeA)).not.toBe(post(value, storeB));
        expect(post(value, storeA)).not.toBe(post(value));
        const base = { method: "POST", body: value, storeId: storeA };
        const params = { orderId: storeA, itemId: storeB };
        const swapped = { itemId: storeB, orderId: storeA };
        expect(requestHash({ ...base, pathParams: params })).toBe(
          requestHash({ ...base, pathParams: swapped }),
        );
        expect(requestHash({ ...base, pathParams: params })).not.toBe(
          requestHash({ ...base, pathParams: { orderId: storeB, itemId: storeA } }),
        );
        expect(requestHash({ ...base, method: "PUT" })).not.toBe(requestHash(base));
        expect(requestHash({ ...base, method: "post" })).toBe(requestHash(base));
      }),
      runs,
    );
  });
});

describe("请求哈希与键的格式：固定用例", () => {
  it("规范化：对象的键排序，undefined 的键去掉，数组顺序不变", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined }, e: undefined })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson(undefined)).toBe("null");
    expect(post([1, 2])).not.toBe(post([2, 1]));
    expect(post({ a: 1, b: undefined })).toBe(post({ a: 1 }));
    expect(post(undefined)).toBe(post(null));
  });

  it("四段的边界不混：把一段的内容挪到另一段，哈希不同", () => {
    const a = requestHash({ method: "POST", pathParams: { id: "1" }, body: {} });
    const b = requestHash({ method: "POST", pathParams: {}, body: { id: "1" } });
    const c = requestHash({ method: "POST", body: null, storeId: "{}" });
    expect(new Set([a, b, c, requestHash({ method: "POST", body: {} })]).size).toBe(4);
  });

  it("已知值钉住口径：改了规范化或拼法，这里先红", () => {
    expect(
      requestHash({
        method: "post",
        pathParams: { orderId: "o-1" },
        body: { qty: 2, sku: "A" },
        storeId: "s-1",
      }),
    ).toBe(KNOWN);
  });

  it("键的格式：1–128 个字符，字符集 [A-Za-z0-9:_-]", () => {
    for (const key of [
      "a",
      "submit:0199c7f4-5b1e-7a2b-8c3d-4e5f6a7b8c9d",
      "A_z-9:",
      "k".repeat(128),
    ]) {
      expect(isIdempotencyKey(key), key).toBe(true);
    }
    for (const key of ["", "k".repeat(129), "a b", "a.b", "a/b", "键", "a\n", 1, null, undefined]) {
      expect(isIdempotencyKey(key), String(key)).toBe(false);
    }
  });
});
