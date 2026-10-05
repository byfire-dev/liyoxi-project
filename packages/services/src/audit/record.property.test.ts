import type { PrismaClient } from "@liyoxi/db";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import { createTxRunner, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { useTestDatabase } from "../testing/index.js";
import { adminMeta, ENTITY_ID, staff } from "./__fixtures__/actors.js";
import { record, toAuditRow } from "./record.js";
import type { AuditEntry } from "./record.js";
import { AUDIT_JSON_MAX_BYTES, AUDIT_TEXT_LIMITS } from "./sanitize.js";

// 验收第 4 条（甲类的性质测试；D4 第 11.1 节“audit.record”）：任意长度、任意字符的输入都不会让写入抛错；
// 截断长度符合规定；before、after 只含变化的键；敏感键永不以明文出现。每一轮都真的往库里写一行再读回来看。
// 轮次与种子的约定同 kernel：PR 上固定种子、每个性质 200 轮；要加大或复现用环境变量，例：
//   LYX_FC_RUNS=2000 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/audit/record.property.test.ts
// 失败时把反例固化成文末的固定用例再修。连库的两条性质失败后收缩反例要一遍遍写库，连跑带收缩到三分钟就停，
// 报当时找到的最小反例；LYX_FC_NO_SHRINK=1 时一步都不收缩（改坏实现看用例红不红时用）。
const runs = {
  numRuns: Number(process.env.LYX_FC_RUNS ?? 200),
  seed: Number(process.env.LYX_FC_SEED ?? 20261005),
  endOnFailure: process.env.LYX_FC_NO_SHRINK === "1",
};
const dbRuns = { ...runs, interruptAfterTimeLimit: 180_000, markInterruptAsFailure: true };

const db = useTestDatabase("services");
let prisma: PrismaClient;
let tx: TxRunner;

beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
}, 120_000);

const base: AuditEntry = {
  stream: "activity",
  category: "profile_edit",
  action: "profile.store.update",
  summary: "改",
};
const write = async (meta: typeof adminMeta, entry: AuditEntry) => {
  const { id } = await tx.run((handle) => record(handle, staff, meta, entry));
  return prisma.auditLog.findUniqueOrThrow({ where: { id } });
};

/** 不成对的代理项（带 u 标志：成对的不命中） */
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;
const unsafe = (text: string): boolean => text.includes("\u0000") || /[\uD800-\uDFFF]/u.test(text);
const cleaned = (text: string): string => text.replaceAll("\u0000", "").replace(LONE_SURROGATE, "");
const lengthOf = (text: string): number => Array.from(text).length;

/** 库里读回来的 JSON：每个键、每个文本都没有 NUL 与不成对的代理项 */
function expectSafeJson(value: unknown): void {
  if (typeof value === "string") expect(unsafe(value)).toBe(false);
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    expect(unsafe(key)).toBe(false);
    expectSafeJson(child);
  }
}

/** 文本：一个个字符里掺 NUL、不成对的代理项、成对的代理项、引号与反斜杠 */
const nastyChar = fc.oneof(
  fc.constantFrom(
    "\u0000",
    "\ud800",
    "\udbff",
    "\udc00",
    "\udfff",
    "🦝",
    "狸",
    '"',
    "\\",
    "…",
    "'",
  ),
  fc.string({ unit: "binary", minLength: 1, maxLength: 1 }),
);
const nasty = (maxLength: number) => fc.string({ unit: nastyChar, maxLength });
/** 有时很长：超过各列的上限 */
const text = fc.oneof(
  nasty(40),
  nasty(30).chain((chunk) => fc.integer({ min: 1, max: 60 }).map((n) => chunk.repeat(n))),
);
/** 任意值：含 bigint、日期、Map、Set、类型化数组、稀疏数组、没有原型的对象，键也是脏文本 */
const anything = fc.anything({
  key: nasty(8),
  values: [
    nasty(20),
    fc.double(),
    fc.bigInt(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.date({ noInvalidDate: false }),
  ],
  maxDepth: 4,
  withBigInt: true,
  withDate: true,
  withMap: true,
  withSet: true,
  withTypedArray: true,
  withSparseArray: true,
  withNullPrototype: true,
  withObjectString: true,
});
/** 把一个值再包 n 层：深层嵌套 */
const nest = (value: unknown, levels: number): unknown =>
  Array.from({ length: levels }).reduce<unknown>(
    (inner, _, index) => (index % 2 ? [inner] : { n: inner }),
    value,
  );
const deep = fc
  .tuple(anything, fc.integer({ min: 0, max: 60 }))
  .map(([value, levels]) => nest(value, levels));
/** 有时超过 16KB */
const big = fc.integer({ min: 1, max: 40 }).map((kb) => "狸".repeat(kb * 400));
const blob = fc.dictionary(nasty(10), fc.oneof(deep, big), { maxKeys: 6 });

describe("audit.record：性质", () => {
  it(
    "任意输入都写入成功；文本列没有 NUL 与不成对的代理项、不超长；三个 jsonb 列不超过 16KB",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            summary: text,
            label: text,
            actorName: text,
            reasonCode: text,
            reasonText: text,
          }),
          fc.record({ userAgent: text, requestId: text, ip: text, key: text }),
          fc.record({ meta: blob, before: blob, after: blob }),
          async (texts, request, json) => {
            const row = await write(
              {
                ...adminMeta,
                actorName: texts.actorName,
                userAgent: request.userAgent,
                requestId: request.requestId,
                ip: request.ip,
              },
              {
                ...base,
                summary: texts.summary,
                target: { type: "dict_type", id: request.key, label: texts.label },
                reason: { code: texts.reasonCode, text: texts.reasonText },
                meta: json.meta,
                before: json.before,
                after: json.after,
                fields: [...Object.keys(json.before), ...Object.keys(json.after)],
              },
            );
            // 截断：不超长；超长的恰好截到上限、以“…”结尾；没超的原样（清洗之后）
            const limited: Array<[string | null, string, number]> = [
              [row.summary, texts.summary, AUDIT_TEXT_LIMITS.summary],
              [row.targetLabel, texts.label, AUDIT_TEXT_LIMITS.targetLabel],
              [row.actorName, texts.actorName, AUDIT_TEXT_LIMITS.actorName],
              [row.reasonText, texts.reasonText, AUDIT_TEXT_LIMITS.reasonText],
              [row.userAgent, request.userAgent, AUDIT_TEXT_LIMITS.userAgent],
            ];
            for (const [stored, input, max] of limited) {
              const want = cleaned(input);
              if (lengthOf(want) <= max) expect(stored).toBe(want);
              else {
                expect(lengthOf(stored ?? "")).toBe(max);
                expect(stored?.endsWith("…")).toBe(true);
                expect(want.startsWith((stored ?? "").slice(0, -1))).toBe(true);
              }
            }
            for (const stored of [
              row.reasonCode,
              row.requestId,
              row.ip,
              row.targetKey,
              row.targetLabel,
            ]) {
              expect(unsafe(stored ?? "")).toBe(false);
            }
            for (const stored of [row.before, row.after, row.meta]) {
              expectSafeJson(stored);
              expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(
                AUDIT_JSON_MAX_BYTES,
              );
            }
          },
        ),
        dbRuns,
      );
    },
  );

  it("before、after 只含白名单里变化的键", () => {
    const keys = ["name", "status", "hours", "tags", "note", "extra"];
    const value = fc.oneof(
      fc.constantFrom(null, undefined, "", "a", "b", 0, 1, true),
      fc.array(fc.constantFrom("x", "y"), { maxLength: 2 }),
      fc.record({ v: fc.constantFrom(1, 2) }),
    );
    const object = fc.dictionary(fc.constantFrom(...keys), value);
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    fc.assert(
      fc.property(object, object, fc.subarray(keys), (before, after, fields) => {
        const row = toAuditRow(staff, adminMeta, { ...base, before, after, fields });
        const changed = fields.filter((key) => !same(before[key], after[key])).sort();
        for (const side of [row.before, row.after]) {
          if (changed.length === 0) expect(side).toBeUndefined();
          else expect(Object.keys(side as object).sort()).toEqual(changed);
        }
        for (const key of changed) {
          expect((row.before as Record<string, unknown>)[key]).toEqual(before[key] ?? null);
          expect((row.after as Record<string, unknown>)[key]).toEqual(after[key] ?? null);
        }
      }),
      runs,
    );
  });

  it(
    "敏感键不以明文出现：口令、令牌类的键连同值剔除；手机号、证照号、银行账号存脱敏值",
    { timeout: 300_000 },
    async () => {
      const secretKeys = [
        "password",
        "passwordHash",
        "access_token",
        "refreshToken",
        "totpSecret",
        "recovery_codes",
        "smsCode",
        "phoneEnc",
        "phone_bidx",
        "apiKey",
        "mfa_secret",
      ];
      const maskedKeys = [
        "phone",
        "contact_phone",
        "newPhone",
        "mobile",
        "uscc",
        "creditCode",
        "bankAccountNo",
        "bank_account",
        "licenseNo",
        "idCardNo",
        "email",
      ];
      const plain = fc.stringMatching(/^[1-9][0-9A-Z]{11,20}$/);
      const holder = fc.dictionary(fc.constantFrom(...secretKeys, ...maskedKeys), plain, {
        minKeys: 1,
        maxKeys: 6,
      });
      await fc.assert(
        fc.asyncProperty(
          holder,
          holder,
          holder,
          fc.integer({ min: 0, max: 6 }),
          async (before, after, inMeta, levels) => {
            const row = await write(adminMeta, {
              ...base,
              entityId: ENTITY_ID,
              before: { profile: nest(before, levels), ...before },
              after: { profile: nest(after, levels), ...after },
              fields: ["profile", ...secretKeys, ...maskedKeys],
              meta: { impact: nest(inMeta, levels), list: [inMeta], ...inMeta },
            });
            const stored = JSON.stringify([row.before, row.after, row.meta]);
            for (const secret of [before, after, inMeta].flatMap((holderObject) =>
              Object.values(holderObject),
            )) {
              expect(stored).not.toContain(secret);
            }
            for (const key of secretKeys) expect(stored).not.toContain(`"${key}"`);
            // 脱敏的键还在，值是带星号的脱敏串
            for (const key of maskedKeys.filter((name) => name in inMeta)) {
              expect((row.meta as Record<string, string>)[key]).toContain("*");
            }
          },
        ),
        dbRuns,
      );
    },
  );
});

describe("audit.record：固定的刁钻输入", () => {
  it(
    "一万层嵌套、循环引用、取属性就抛错的对象、bigint、__proto__ 键、1MB 的 UA：照样写入",
    { timeout: 60_000 },
    async () => {
      const cyclic: Record<string, unknown> = { name: "环" };
      cyclic.self = cyclic;
      const hostile = new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("不给看");
          },
        },
      );
      const getter = {
        get boom(): never {
          throw new Error("取不出");
        },
        ok: 1,
      };
      const proto = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}') as object;
      const row = await write(
        { ...adminMeta, userAgent: "U".repeat(1024 * 1024) },
        {
          ...base,
          // $type、__prismaRawParameters__ 是 Prisma 自己认的键名：内容里出现不能让写入失败，读回来也不能变样
          meta: {
            deepNest: nest("底", 10_000),
            cyclic,
            hostile,
            getter,
            big: 2n ** 80n,
            proto,
            when: new Date(Number.NaN),
            bytes: new Uint8Array(5),
            "\ud800k\u0000": "v\udc00",
            tagged: { $type: "BigInt", value: "不是数" },
            $type: "",
            raw: { __prismaRawParameters__: true, values: [1] },
          },
          before: { a: [1, nest(1, 10_000)], b: nest(1, 10_000), __proto__: null },
          after: { a: [2, nest(1, 10_000)], b: nest(2, 10_000) },
          fields: ["a", "b", "__proto__", "constructor"],
        },
      );
      expect(lengthOf(row.userAgent ?? "")).toBe(512);
      expect(row.meta).toMatchObject({
        cyclic: { name: "环", self: "[循环引用，略]" },
        hostile: "[读不出，略]",
        getter: "[读不出，略]",
        big: "1208925819614629174706176",
        proto: { __proto__: { polluted: true }, constructor: 1 },
        when: null,
        bytes: "[二进制 5 字节]",
        k: "v",
        tagged: { $type: "BigInt", value: "不是数" },
        $type: "",
        raw: { __prismaRawParameters__: true, values: [1] },
      });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(JSON.stringify(row.meta)).toContain("[嵌套过深，略]");
      // 继承来的 __proto__、constructor 不算字段；b 的差别在嵌套上限之外，看不出来，不记
      expect(Object.keys(row.before as object)).toEqual(["a"]);
      expect((row.after as { a: unknown[] }).a[0]).toBe(2);
    },
  );

  it("超过 16KB 的 before、after、meta 改存 { keys, length, sha256 }", async () => {
    const huge = { note: "狸".repeat(8000), id: uuidv7() };
    const row = await write(adminMeta, {
      ...base,
      meta: huge,
      before: { note: "" },
      after: huge,
      fields: ["note"],
    });
    expect(row.meta).toEqual({
      keys: ["id", "note"],
      length: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect((row.meta as { length: number }).length).toBeGreaterThan(AUDIT_JSON_MAX_BYTES);
    expect(row.after).toMatchObject({ keys: ["note"] });
    expect(row.before).toEqual({ note: "" });
  });
});
