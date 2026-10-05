import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "../testing/index.js";
import { bump, gate, openClient, put, rows } from "./__fixtures__/db.js";
import { idemRows, merchant, requestOf, untilWaiting } from "./__fixtures__/idempotency.js";
import { IDEMPOTENCY_LOCK_WAIT_MS } from "./idempotency.js";
import { createTxRunner } from "./tx.js";
import type { Tx, TxRunner } from "./tx.js";

// 验收第 1–3 条（甲类的并发测试，D7 第 10.3 节 C14）：两条独立连接发同一个键。
// 对齐不靠睡：抢到登记的一方在业务里等，直到在 pg_locks 里看见另一方卡在幂等行的主键上，才往下走。
// 这样每一轮都是真的“后到者阻塞在主键上”，不是碰巧一前一后。
// 两条连接自己的 lock_timeout 是 0（不超时）：3 秒是登记那一句自己设的。

const ROUNDS = 20;
const SLOW = 120_000;

const db = useTestDatabase("services");
let prisma: PrismaClient;
let left: PrismaClient;
let right: PrismaClient;
let one: TxRunner;
let two: TxRunner;

beforeAll(async () => {
  prisma = await db.prisma();
  [left, right] = await Promise.all([openClient(db), openClient(db)]);
  one = createTxRunner({ prisma: left, appEnv: "test" });
  two = createTxRunner({ prisma: right, appEnv: "test" });
  await put(prisma, "CC");
}, SLOW);

afterAll(async () => {
  await Promise.all([left, right].map((client) => client?.$disconnect()));
});

const executed = async (): Promise<number> => ((await rows(prisma)).CC ?? 0) - 1;

describe("幂等：同键并发", () => {
  it(
    `同键并发 ${ROUNDS} 轮：业务只执行一次，两个调用返回值相同，后到者带重放标记`,
    async () => {
      const actor = merchant();
      for (let round = 0; round < ROUNDS; round += 1) {
        const key = `submit:race-${round}`;
        const before = await executed();
        let calls = 0;
        const business = async (handle: Tx): Promise<{ round: number; serial: number }> => {
          calls += 1;
          await bump(handle, "CC");
          await untilWaiting(prisma);
          return { round, serial: (await rows(handle)).CC ?? 0 };
        };
        const contexts = [requestOf(actor, key), requestOf(actor, key)] as const;
        const [a, b] = await Promise.all([
          one.run(business, { idem: contexts[0] }),
          two.run(business, { idem: contexts[1] }),
        ]);
        const label = `第 ${round + 1} 轮`;
        expect(calls, label).toBe(1);
        expect(a, label).toEqual(b);
        expect(a.round, label).toBe(round);
        expect(contexts.map((ctx) => ctx.replayed).sort(), label).toEqual([false, true]);
        expect(await executed(), label).toBe(before + 1);
      }
      expect(await idemRows(prisma)).toHaveLength(ROUNDS);
    },
    SLOW,
  );

  it(
    `第一个回滚 ${ROUNDS} 轮：幂等表不留它的行，阻塞着的第二个接着正常执行并成功`,
    async () => {
      const actor = merchant();
      for (let round = 0; round < ROUNDS; round += 1) {
        const key = `submit:rollback-${round}`;
        const before = await executed();
        const label = `第 ${round + 1} 轮`;
        const failed = new Error("第一个请求业务失败");
        const entered = gate();
        const first = requestOf(actor, key);
        const second = requestOf(actor, key);
        const losing = one.run(
          async (handle) => {
            await bump(handle, "CC");
            entered.open();
            await untilWaiting(prisma);
            throw failed;
          },
          { idem: first },
        );
        // 第一个已经登记、业务做到一半，第二个才发：它一定阻塞在主键上
        await entered.opened;
        const winning = two.run(
          async (handle) => {
            await bump(handle, "CC");
            return { by: "second", round };
          },
          { idem: second },
        );
        await expect(losing, label).rejects.toBe(failed);
        expect(await winning, label).toEqual({ by: "second", round });
        expect(second.replayed, label).toBe(false);
        // 第一个的加一随事务回滚了，只有第二个的算数；幂等表里是第二个写的那一行
        expect(await executed(), label).toBe(before + 1);
        const kept = (await idemRows(prisma)).filter((row) => row.key === key);
        expect(kept, label).toMatchObject([{ state: "done", result: { by: "second", round } }]);
      }
    },
    SLOW,
  );

  it(
    "第一个事务挂起超过 3 秒：第二个得到 BUSY，耗时在 3 到 4 秒之间，业务没有执行，也没有重试",
    async () => {
      const actor = merchant();
      const key = "submit:busy-1";
      const before = await executed();
      const entered = gate();
      const release = gate();
      const holding = one.run(
        async (handle) => {
          await bump(handle, "CC");
          entered.open();
          await release.opened;
          return "first";
        },
        { idem: requestOf(actor, key) },
      );
      await entered.opened;

      let calls = 0;
      const startedAt = performance.now();
      const waiting = two.run(
        () => {
          calls += 1;
          return Promise.resolve("second");
        },
        { idem: requestOf(actor, key) },
      );
      await expect(waiting).rejects.toMatchObject({ name: "AppError", error: "BUSY" });
      const elapsed = performance.now() - startedAt;
      expect(IDEMPOTENCY_LOCK_WAIT_MS).toBe(3_000);
      expect(elapsed).toBeGreaterThanOrEqual(3_000);
      expect(elapsed).toBeLessThan(4_000);
      expect(calls).toBe(0);

      // 第一个照常提交；之后用同一个键再来，拿到它的结果
      release.open();
      expect(await holding).toBe("first");
      const replay = requestOf(actor, key);
      expect(await two.run(() => Promise.resolve("third"), { idem: replay })).toBe("first");
      expect(replay.replayed).toBe(true);
      expect(await executed()).toBe(before + 1);
    },
    SLOW,
  );
});
