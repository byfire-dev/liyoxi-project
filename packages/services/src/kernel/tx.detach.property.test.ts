import type { PrismaClient } from "@liyoxi/db";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { assertNotInTransaction, createTxRunner, detach, isInTransaction } from "./tx.js";

const runs = {
  numRuns: Number(process.env.LYX_FC_RUNS ?? 200),
  seed: Number(process.env.LYX_FC_SEED ?? 20261007),
};
const pause = async (count: number) => {
  for (let i = 0; i < count; i++) await Promise.resolve();
};

describe("detach：异步交错性质（真实 ALS，数据库语义见 db 用例）", () => {
  it("随机深度、让出与失败不会串改兄弟链；独立事务结束后回到脱离链", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 5 }),
        fc.boolean(),
        async (depth, yields, fail) => {
          const client = { $queryRawUnsafe: async () => [] };
          const prisma = {
            $transaction: async (fn: (handle: typeof client) => Promise<unknown>) =>
              fn({ ...client }),
          } as unknown as PrismaClient;
          const tx = createTxRunner({ prisma, appEnv: "test" });
          const boom = new Error("生成的失败");
          const descend = async (remaining: number): Promise<void> =>
            detach(async () => {
              await pause(yields);
              expect(isInTransaction()).toBe(false);
              expect(() => assertNotInTransaction("property.provider")).toThrow();
              if (remaining > 1) await descend(remaining - 1);
              else {
                await tx.run(async () => {
                  await pause(yields);
                  expect(isInTransaction()).toBe(true);
                });
                expect(isInTransaction()).toBe(false);
                if (fail) throw boom;
              }
            });
          await tx.run(async () => {
            const independent = descend(depth).catch((error: unknown) => {
              expect(fail).toBe(true);
              expect(error).toBe(boom);
            });
            const sibling = (async () => {
              await pause(yields + 1);
              expect(isInTransaction()).toBe(true);
              await expect(tx.run(async () => null)).rejects.toMatchObject({
                kind: "nested_transaction",
              });
            })();
            await Promise.all([independent, sibling]);
            expect(isInTransaction()).toBe(true);
          });
          expect(isInTransaction()).toBe(false);
        },
      ),
      runs,
    );
  }, 30_000);
});
