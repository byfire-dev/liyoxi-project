import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClock, useTestDatabase } from "../testing/index.js";
import { openClient } from "./__fixtures__/db.js";
import { createBizNoIssuer } from "./biz-no.js";
import { createTxRunner } from "./tx.js";

// 验收第 8 条（甲类的并发测试）：8 条独立连接各取 50 个同前缀同日的号。
// 每条连接分 10 个事务取，一个事务取 5 个（一个号一个事务要 400 多个事务，CI 上太慢；抢锁发生在每个事务的第一次取号，
// 80 次已经够把它们搅在一起）。其间每条连接另有 5 个事务取了号又回滚。
// 判据：400 个互不相同，流水恰为 1–400：没有重号，回滚的事务也没有留下空号。

const CONNECTIONS = 8;
const TRANSACTIONS = 10;
const PER_TRANSACTION = 5;
const TOTAL = CONNECTIONS * TRANSACTIONS * PER_TRANSACTION;
const SLOW = 120_000;

const db = useTestDatabase("services");
let prisma: PrismaClient;
let clients: PrismaClient[] = [];

beforeAll(async () => {
  prisma = await db.prisma();
  clients = await Promise.all(Array.from({ length: CONNECTIONS }, () => openClient(db)));
}, SLOW);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

const serialOf = (no: string | undefined): number => Number(no?.slice(-5));

describe("业务单号：并发取号", () => {
  it(
    `${CONNECTIONS} 条连接各取 ${TRANSACTIONS * PER_TRANSACTION} 个：互不相同，流水恰为 1–${TOTAL}；回滚的事务不留空号`,
    async () => {
      const issuer = createBizNoIssuer({ clock: createClock(), appEnv: "test" });
      const discarded = new Error("取了号又回滚");
      let rolledBack = 0;
      const perConnection = await Promise.all(
        clients.map(async (client) => {
          const tx = createTxRunner({ prisma: client, appEnv: "test" });
          const mine: string[] = [];
          for (let round = 0; round < TRANSACTIONS; round += 1) {
            if (round % 2 === 0) {
              await tx
                .run(async (handle) => {
                  await issuer.next(handle, "LYX");
                  await issuer.next(handle, "LYX");
                  throw discarded;
                })
                .catch((error: unknown) => {
                  if (error !== discarded) throw error;
                  rolledBack += 1;
                });
            }
            const taken = await tx.run(async (handle) => {
              const batch: string[] = [];
              for (let index = 0; index < PER_TRANSACTION; index += 1) {
                batch.push(await issuer.next(handle, "LYX"));
              }
              return batch;
            });
            // 一个事务里取的几个是连号：行锁拿到提交，中间插不进别人
            expect(serialOf(taken.at(-1)) - serialOf(taken[0])).toBe(PER_TRANSACTION - 1);
            mine.push(...taken);
          }
          return mine;
        }),
      );

      const all = perConnection.flat();
      expect(all).toHaveLength(TOTAL);
      expect(new Set(all).size).toBe(TOTAL);
      expect(rolledBack).toBe((CONNECTIONS * TRANSACTIONS) / 2);
      for (const no of all) expect(no).toMatch(/^LYX20260105\d{5}$/);
      const serials = all.map(serialOf).sort((a, b) => a - b);
      expect(serials).toEqual(Array.from({ length: TOTAL }, (_, index) => index + 1));
      // 每条连接自己拿到的号是递增的
      for (const mine of perConnection) expect([...mine].sort()).toEqual(mine);
      // 真的交错了：至少有一条连接的号中间夹着别人的
      const spans = perConnection.map((mine) => serialOf(mine.at(-1)) - serialOf(mine[0]));
      expect(Math.max(...spans)).toBeGreaterThan(TRANSACTIONS * PER_TRANSACTION);
      expect(await prisma.bizSequence.findMany()).toMatchObject([
        { prefix: "LYX", nextVal: TOTAL + 1 },
      ]);
    },
    SLOW,
  );
});
