import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isAppError } from "../kernel/index.js";
import { createSampleFlow, useTestDatabase } from "../testing/index.js";
import type { SampleFlow } from "../testing/index.js";
import {
  barrier,
  changed,
  companionsFor,
  historyOf,
  insertEntity,
  openClient,
  SLOW,
  staffContext,
  stateOf,
  tally,
} from "./__fixtures__/db.js";
import { findI12Violations } from "./invariants.js";

// 验收第 6 条（甲类的并发测试）：两条独立连接对同一对象同时做同一个会改变状态的迁移，重复 20 次。
// 每一轮：一个成功，另一个得 STATE_NOT_ALLOWED；状态历史只多 1 行，审计、事件也各只多 1 行。
// 靠的是对象行的 FOR UPDATE：后到的一方等前一方提交，拿到锁后读到的已是新状态，迁移表里查不到这一对（状态, 事件）。

const ROUNDS = 20;

const db = useTestDatabase("services");
let prisma: PrismaClient;
let left: PrismaClient;
let right: PrismaClient;
let sides: SampleFlow[];
const ctx = staffContext();

beforeAll(async () => {
  prisma = await db.prisma();
  [left, right] = await Promise.all([openClient(db), openClient(db)]);
  sides = [createSampleFlow(left), createSampleFlow(right)];
}, SLOW);

afterAll(async () => {
  await Promise.all([left, right].map((client) => client?.$disconnect()));
});

describe("transition：并发（验收 6）", () => {
  it(
    `两条连接同时放弃同一个主体，重复 ${ROUNDS} 次：每轮一个成功、一个被拒，历史只多 1 行`,
    async () => {
      const outcomes: string[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const id = await insertEntity(prisma);
        const before = await tally(prisma);
        const start = barrier(2);
        const results = await Promise.allSettled(
          sides.map((side) =>
            side.tx.run(async (tx) => {
              await start(); // 两边的事务都开了才一起往下走
              return side.flow.transition(tx, ctx, {
                machine: "entity",
                stateField: "lifecycle",
                id,
                event: "entity.abandon",
                emit: changed,
                entityId: id,
                set: companionsFor("entity.lifecycle", "abandoned", side.clock.now()),
              });
            }),
          ),
        );
        const won = results.filter((result) => result.status === "fulfilled");
        const lost = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        outcomes.push(`${won.length} 成功 / ${lost.length} 被拒`);
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect(isAppError(lost[0]) && lost[0].error).toBe("STATE_NOT_ALLOWED");
        expect(lost[0]).toMatchObject({ details: { state: "abandoned", event: "entity.abandon" } });
        expect(await tally(prisma)).toEqual({
          history: before.history + 1,
          audit: before.audit + 1,
          events: before.events + 1,
        });
        expect(await historyOf(prisma, id)).toHaveLength(1);
        expect(await stateOf(prisma, "entity", "lifecycle", id)).toBe("abandoned");
      }
      expect(await findI12Violations(prisma)).toEqual([]);
      process.stdout.write(
        `[flow 并发] ${ROUNDS} 轮：${[...new Set(outcomes)].join("；")}，flow.I12 0 违规\n`,
      );
    },
    SLOW * 2,
  );
});
