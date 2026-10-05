import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { useTestDatabase } from "../testing/index.js";
import { bump, openClient, put, rows } from "./__fixtures__/db.js";
import { idemRows, merchant, requestOf, SCOPE } from "./__fixtures__/idempotency.js";
import { AppError } from "./errors.js";
import {
  assertIdempotencyUsed,
  isUniqueViolation,
  purgeExpiredIdempotencyRecords,
} from "./idempotency-tools.js";
import { createIdempotencyContext, redactForReplay } from "./idempotency.js";
import { createTxRunner, KernelViolation, savepoint } from "./tx.js";
import type { Tx, TxRunner } from "./tx.js";

// 验收第 4、5、7 条：重放与只持久化成功、结果脱敏重放、防漏用与清理。连真库；并发的三条在 idempotency.concurrency.test.ts。
// “业务”是给 biz_sequence 的 CT 行加一：next_val 就是业务执行了几次（起点是 1）。

const db = useTestDatabase("services");
let prisma: PrismaClient;
let tx: TxRunner;

beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
  await put(prisma, "CT");
}, 120_000);

const executed = async (): Promise<number> => ((await rows(prisma)).CT ?? 0) - 1;
/** 业务：计数加一，返回一份带计数的 DTO */
const order = async (handle: Tx): Promise<{ orderNo: string; items: { id: number }[] }> => {
  await bump(handle, "CT");
  return { orderNo: `N${await handle.bizSequence.count()}`, items: [{ id: 1 }, { id: 2 }] };
};
const rejects = (attempt: Promise<unknown>, error: string): Promise<void> =>
  expect(attempt).rejects.toMatchObject({ name: "AppError", error });

describe("幂等：重放与只持久化成功（验收 4）", () => {
  it("同键调用 5 次：业务只执行一次，返回值相同，表内容与调用 1 次相同", async () => {
    const actor = merchant();
    const before = await executed();
    const first = requestOf(actor, "submit:replay-1");
    const result = await tx.run(order, { idem: first });
    expect(first).toMatchObject({ used: true, replayed: false });
    const snapshot = { idem: await idemRows(prisma), biz: await rows(prisma) };
    expect(snapshot.idem.filter((row) => row.key === "submit:replay-1")).toMatchObject([
      { scope: SCOPE, actorKey: `merchant:${actor.id}`, state: "done", result, lockedUntil: null },
    ]);

    for (let again = 0; again < 4; again += 1) {
      const replay = requestOf(actor, "submit:replay-1");
      expect(await tx.run(order, { idem: replay })).toEqual(result);
      expect(replay).toMatchObject({ used: true, replayed: true });
    }
    expect(await executed()).toBe(before + 1);
    expect({ idem: await idemRows(prisma), biz: await rows(prisma) }).toEqual(snapshot);
  });

  it("幂等行：请求哈希 64 位小写十六进制，expires_at 正好是 created_at 之后 24 小时", async () => {
    const actor = merchant();
    const ctx = requestOf(actor, "submit:row-1");
    await tx.run(order, { idem: ctx });
    const row = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        scope_actorKey_key: { scope: SCOPE, actorKey: `merchant:${actor.id}`, key: "submit:row-1" },
      },
    });
    expect(row.requestHash).toBe(ctx.requestHash);
    expect(row.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(24 * 3_600_000);
  });

  it("业务失败不留记录；同键重试成功，改了输入也行", async () => {
    const actor = merchant();
    const before = await executed();
    const failed = new Error("库存不足");
    await expect(
      tx.run(
        async (handle) => {
          await order(handle);
          throw failed;
        },
        { idem: requestOf(actor, "submit:fail-1", { qty: 99 }) },
      ),
    ).rejects.toBe(failed);
    expect((await idemRows(prisma)).filter((row) => row.key === "submit:fail-1")).toEqual([]);
    expect(await executed()).toBe(before);

    const retry = requestOf(actor, "submit:fail-1", { qty: 1 });
    await tx.run(order, { idem: retry });
    expect(retry.replayed).toBe(false);
    expect(await executed()).toBe(before + 1);
  });

  it("同键换内容、换门店：IDEMPOTENCY_KEY_REUSED，业务不执行", async () => {
    const actor = merchant();
    await tx.run(order, { idem: requestOf(actor, "submit:reuse-1", { qty: 1 }) });
    const before = await executed();
    await rejects(
      tx.run(order, { idem: requestOf(actor, "submit:reuse-1", { qty: 2 }) }),
      "IDEMPOTENCY_KEY_REUSED",
    );
    const otherStore = { method: "POST", body: { qty: 1 }, storeId: "another-store" };
    await rejects(
      tx.run(order, { idem: requestOf(actor, "submit:reuse-1", null, { request: otherStore }) }),
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(await executed()).toBe(before);
  });

  it("键按（路由、操作人、键）区分：换操作人、换路由各执行各的", async () => {
    const actor = merchant();
    const before = await executed();
    await tx.run(order, { idem: requestOf(actor, "submit:scope-1") });
    await tx.run(order, { idem: requestOf(merchant(), "submit:scope-1") });
    await tx.run(order, {
      idem: requestOf(actor, "submit:scope-1", { qty: 1 }, { scope: "m.ad.create" }),
    });
    expect(await executed()).toBe(before + 3);
  });

  it("required 缺键或键的格式不对：IDEMPOTENCY_KEY_REQUIRED", () => {
    const bad = [undefined, null, "", "a".repeat(129), "a b", "a.b", "键", "a/b"];
    for (const key of bad) {
      let thrown: unknown;
      try {
        requestOf(merchant(), key as string);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, String(key)).toBeInstanceOf(AppError);
      expect(thrown, String(key)).toMatchObject({ error: "IDEMPOTENCY_KEY_REQUIRED" });
    }
    expect(requestOf(merchant(), `${"a".repeat(64)}:${"Z9_-".repeat(15)}xyz`).key).toHaveLength(
      128,
    );
  });

  it("natural、none：调用后幂等表一行不多，上下文记为用过", async () => {
    const before = await idemRows(prisma);
    const executedBefore = await executed();
    for (const mode of ["natural", "none"] as const) {
      const ctx = createIdempotencyContext({ mode, scope: "m.file.create", key: "submit:ignored" });
      expect(ctx).toMatchObject({ key: null, actorKey: null, requestHash: null, used: false });
      await tx.run(order, { idem: ctx });
      await tx.run(order, { idem: ctx });
      expect(ctx).toMatchObject({ used: true, replayed: false });
    }
    expect(await idemRows(prisma)).toEqual(before);
    expect(await executed()).toBe(executedBefore + 4);
  });

  it("没有返回值的用例：result 留空，重放得到 undefined，业务不再执行", async () => {
    const actor = merchant();
    const before = await executed();
    const first = await tx.run((handle) => bump(handle, "CT").then(() => undefined), {
      idem: requestOf(actor, "submit:void-1"),
    });
    const replay = requestOf(actor, "submit:void-1");
    expect(await tx.run(order, { idem: replay })).toBe(first);
    expect(first).toBeUndefined();
    expect(replay.replayed).toBe(true);
    expect(await executed()).toBe(before + 1);
  });

  it("读到 in_progress 的行（三段式占用中，W0-20 才会产生）：IDEMPOTENCY_IN_PROGRESS", async () => {
    const actor = merchant();
    const ctx = requestOf(actor, "submit:three-1");
    await prisma.idempotencyRecord.create({
      data: {
        scope: SCOPE,
        actorKey: `merchant:${actor.id}`,
        key: "submit:three-1",
        requestHash: ctx.requestHash as string,
        state: "in_progress",
        lockedUntil: new Date(Date.now() + 30_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await rejects(tx.run(order, { idem: ctx }), "IDEMPOTENCY_IN_PROGRESS");
  });

  it("可重试的错误让函数体重跑：登记随第一遍回滚，第二遍重新登记，只留一行，不算重放", async () => {
    const actor = merchant();
    const before = await executed();
    const ctx = requestOf(actor, "submit:retry-1");
    let calls = 0;
    const serialization = Object.assign(new Error("造一条序列化失败"), {
      meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
    });
    await tx.run(
      async (handle) => {
        calls += 1;
        const result = await order(handle);
        if (calls === 1) throw serialization;
        return result;
      },
      { idem: ctx },
    );
    expect(calls).toBe(2);
    expect(ctx.replayed).toBe(false);
    expect(await executed()).toBe(before + 1);
    expect((await idemRows(prisma)).filter((row) => row.key === "submit:retry-1")).toHaveLength(1);
  });

  it("等锁的 3 秒只管登记那一句：业务里看到的 lock_timeout 还是连接原来的", async () => {
    const tuned = await openClient(db, { lockTimeoutMs: 1_234 });
    try {
      for (const [client, expected] of [
        [tuned, "1234ms"],
        [prisma, "0"],
      ] as const) {
        const seen = await createTxRunner({ prisma: client, appEnv: "test" }).run(
          async (handle) => {
            const [row] = await handle.$queryRaw<{ value: string }[]>`
              SELECT current_setting('lock_timeout') AS value`;
            return row?.value;
          },
          { idem: requestOf(merchant(), "submit:timeout-1") },
        );
        expect(seen).toBe(expected);
      }
    } finally {
      await tuned.$disconnect();
    }
  });
});

describe("幂等：结果脱敏重放（验收 5）", () => {
  const redact = ["payParams", "items[].posterUrl", "bankAccount.accountNo", "absent.field"];
  const fresh = () => ({
    orderNo: "LYX2026010500001",
    payParams: { nonceStr: "n", paySign: "s" },
    items: [
      { id: 1, posterUrl: "https://cdn.example/1.jpg?sig=a" },
      { id: 2, posterUrl: "https://cdn.example/2.jpg?sig=b" },
    ],
    bankAccount: { bank: "招商银行", accountNo: "6225000011112222" },
  });
  const blanked = {
    orderNo: "LYX2026010500001",
    payParams: null,
    items: [
      { id: 1, posterUrl: null },
      { id: 2, posterUrl: null },
    ],
    bankAccount: { bank: "招商银行", accountNo: null },
  };

  it("登记的路径在库里是 null；重放带 replayed: true 且这些字段为 null；首次返回值不变", async () => {
    const actor = merchant();
    const returned = fresh();
    const first = await tx.run(() => Promise.resolve(returned), {
      idem: requestOf(actor, "pay:redact-1", { qty: 1 }, { redact }),
    });
    expect(first).toBe(returned);
    expect(first).toEqual(fresh());

    const [row] = (await idemRows(prisma)).filter((found) => found.key === "pay:redact-1");
    expect(row?.result).toEqual(blanked);

    const replay = requestOf(actor, "pay:redact-1", { qty: 1 }, { redact });
    expect(await tx.run(() => Promise.resolve(fresh()), { idem: replay })).toEqual({
      ...blanked,
      replayed: true,
    });
    expect(replay.replayed).toBe(true);
  });

  it("没有登记脱敏路径的路由：重放的结果不加 replayed 字段，只在上下文上标", async () => {
    const actor = merchant();
    await tx.run(() => Promise.resolve(fresh()), { idem: requestOf(actor, "pay:plain-1") });
    const replay = requestOf(actor, "pay:plain-1");
    expect(await tx.run(() => Promise.resolve(fresh()), { idem: replay })).toEqual(fresh());
    expect(replay.replayed).toBe(true);
  });

  it("redactForReplay：不改原对象；字段不在、中间一段是 null 或不是数组时不动；路径写法不对建上下文时即抛", () => {
    const source = { a: { b: 1 }, list: null, items: "不是数组", keep: 1 };
    expect(redactForReplay(source, ["a.b", "list[].x", "items[].x", "nope", "keep.x"])).toEqual({
      a: { b: null },
      list: null,
      items: "不是数组",
      keep: 1,
    });
    expect(source.a.b).toBe(1);
    expect(redactForReplay([{ a: 1 }], ["a"])).toEqual([{ a: 1 }]);
    expect(redactForReplay(undefined, ["a"])).toBeUndefined();
    for (const path of ["", "a.", ".a", "a[]", "a..b", "a[0].b", "a b"]) {
      expect(() => requestOf(merchant(), "pay:bad-path", null, { redact: [path] }), path).toThrow(
        TypeError,
      );
    }
  });
});

describe("幂等：防漏用与清理（验收 7）", () => {
  it("required 的上下文没进过 tx.run：测试环境抛错，生产只上报；用过的、natural、none 不报", async () => {
    const unused = requestOf(merchant(), "submit:unused-1");
    expect(() => assertIdempotencyUsed(unused, { appEnv: "test" })).toThrow(KernelViolation);
    expect(() => assertIdempotencyUsed(unused, { appEnv: "local" })).toThrow(
      expect.objectContaining({ kind: "idempotency_unused" }),
    );
    const report = vi.fn();
    assertIdempotencyUsed(unused, { appEnv: "prod", report });
    assertIdempotencyUsed(unused, { appEnv: "stg", report });
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0]?.[0]).toMatchObject({ kind: "idempotency_unused" });

    await tx.run(order, { idem: unused });
    assertIdempotencyUsed(unused, { appEnv: "test" });
    for (const mode of ["natural", "none"] as const) {
      assertIdempotencyUsed(createIdempotencyContext({ mode, scope: SCOPE }), { appEnv: "test" });
    }
  });

  it("一个 required 的上下文只给一次 tx.run：第二次即抛错，业务不执行", async () => {
    const ctx = requestOf(merchant(), "submit:twice-1");
    await tx.run(order, { idem: ctx });
    const before = await executed();
    await expect(tx.run(order, { idem: ctx })).rejects.toMatchObject({
      name: "KernelViolation",
      kind: "idempotency_context_reused",
    });
    expect(await executed()).toBe(before);
  });

  it("过期清理只删已过期的行，按过期先后，单轮不超过上限", async () => {
    const actor = merchant();
    const hour = 3_600_000;
    const seed = (key: string, expiresInMs: number) =>
      prisma.idempotencyRecord.create({
        data: {
          scope: "m.purge.test",
          actorKey: `merchant:${actor.id}`,
          key,
          requestHash: "0".repeat(64),
          state: "done",
          createdAt: new Date(Date.now() + expiresInMs - 24 * hour),
          expiresAt: new Date(Date.now() + expiresInMs),
        },
      });
    // 五行已过期（越靠前过期越早），两行还没到
    for (const [index, key] of ["old-1", "old-2", "old-3", "old-4", "old-5"].entries()) {
      await seed(key, -(10 - index) * hour);
    }
    await seed("live-1", hour);
    await seed("live-2", 60_000);
    const total = (await idemRows(prisma)).length;
    const left = async (): Promise<string[]> =>
      (await idemRows(prisma)).filter((row) => row.scope === "m.purge.test").map((row) => row.key);

    expect(await tx.run((handle) => purgeExpiredIdempotencyRecords(handle, 3))).toBe(3);
    expect(await left()).toEqual(["live-1", "live-2", "old-4", "old-5"]);
    expect(await tx.run((handle) => purgeExpiredIdempotencyRecords(handle))).toBe(2);
    expect(await tx.run((handle) => purgeExpiredIdempotencyRecords(handle))).toBe(0);
    expect(await left()).toEqual(["live-1", "live-2"]);
    // 别的用例留下的、没过期的行一行没动
    expect((await idemRows(prisma)).length).toBe(total - 5);
    await expect(tx.run((handle) => purgeExpiredIdempotencyRecords(handle, 0))).rejects.toThrow(
      RangeError,
    );
  });

  it("isUniqueViolation（natural 的路由用）：只认点了名的约束；包在保存点里接住之后事务还能用", async () => {
    await tx.run(async (handle) => {
      const duplicate = await savepoint(handle, () => put(handle, "CT")).catch(
        (error: unknown) => error,
      );
      expect(isUniqueViolation(duplicate, ["pk_biz_sequence"])).toBe(true);
      expect(isUniqueViolation(duplicate, ["pk_biz", "uq_other"])).toBe(false);
      expect(isUniqueViolation(new Error("别的错"), ["pk_biz_sequence"])).toBe(false);
      await bump(handle, "CT");
    });
    const raw =
      await prisma.$executeRaw`INSERT INTO biz_sequence (prefix, biz_date, next_val) VALUES ('CT', '2026-01-05', 1)`.catch(
        (error: unknown) => error,
      );
    expect(isUniqueViolation(raw, ["uq_other", "pk_biz_sequence"])).toBe(true);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
