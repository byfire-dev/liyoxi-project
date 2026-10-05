// 验收第 3 条（任务书 W1-06 第 7 节；甲类的并发测试）：两条独立连接对同一张待审的单同时决定，栅栏对齐，
// 通过 × 通过、通过 × 驳回、通过 × 撤回各重复 20 次。每一轮：恰一个成功，另一个 409 APPROVAL_NOT_PENDING；
// 处理器只执行 1 次；状态历史、审计、事件各只多 1 行。
// 靠的是审批单行的行锁：后到的一方等前一方提交，拿到锁后重读，看到的已是终态。
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isAppError } from "../kernel/index.js";
import { createSampleApproval } from "../testing/index.js";
import type { SampleApproval } from "../testing/index.js";

import { barrier, openClient, SLOW, useApprovalWorld } from "./__fixtures__/world.js";
import type { Merchant, Person } from "./__fixtures__/world.js";
import type { DecisionResult } from "./decide.js";

const ROUNDS = 20;

const world = useApprovalWorld();
let left: PrismaClient;
let right: PrismaClient;
let sides: [SampleApproval, SampleApproval];
let requester: Person;
let financeA: Person;
let financeB: Person;
let merchant: Merchant;

beforeAll(async () => {
  [left, right] = await Promise.all([openClient(world.db), openClient(world.db)]);
  sides = [createSampleApproval(left), createSampleApproval(right)];
  requester = await world.person({ role: "cs" });
  [financeA, financeB] = await Promise.all([world.person(), world.person()]);
  merchant = await world.merchant();
}, SLOW);

afterAll(async () => {
  await Promise.all([left, right].map((client) => client?.$disconnect()));
});

type Move = (
  side: SampleApproval,
  approvalId: string,
  ready: () => Promise<void>,
) => Promise<DecisionResult>;

/** 两边的事务都开了才一起往下走 */
const approveBy =
  (person: () => Person): Move =>
  (side, approvalId, ready) =>
    side.tx.run(async (tx) => {
      await ready();
      return side.approval.approve(tx, person().identity, {
        approvalId,
        staff: person().staff,
        lockVersion: 0,
      });
    });
const rejectBy =
  (person: () => Person): Move =>
  (side, approvalId, ready) =>
    side.tx.run(async (tx) => {
      await ready();
      return side.approval.reject(tx, person().identity, {
        approvalId,
        staff: person().staff,
        note: "依据不足",
      });
    });
const withdrawBy =
  (person: () => Person): Move =>
  (side, approvalId, ready) =>
    side.tx.run(async (tx) => {
      await ready();
      return side.approval.withdraw(tx, person().identity, { approvalId, staff: person().staff });
    });

const PAIRS: ReadonlyArray<readonly [name: string, first: Move, second: Move]> = [
  ["通过 × 通过", approveBy(() => financeA), approveBy(() => financeB)],
  ["通过 × 驳回", approveBy(() => financeA), rejectBy(() => financeB)],
  ["通过 × 撤回", approveBy(() => financeA), withdrawBy(() => requester)],
];

describe("决定：并发（验收 3）", () => {
  it.each(PAIRS)(
    `%s，重复 ${String(ROUNDS)} 次：每轮恰一个成功、另一个 APPROVAL_NOT_PENDING，回调 1 次，三处各多 1 行`,
    async (name, first, second) => {
      const winners: string[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        // 同一个主体可以反复用：上一轮的单已是终态，去重索引只管在途的
        const { approvalId } = await world.sample.submit(
          requester.identity,
          world.input.pointsAdjust(merchant),
        );
        const ready = barrier(2);
        const results = await Promise.allSettled([
          first(sides[0], approvalId, ready),
          second(sides[1], approvalId, ready),
        ]);
        const won = results.filter((result) => result.status === "fulfilled");
        const lost = results.filter((result) => result.status === "rejected");
        expect(won, `第 ${String(round)} 轮`).toHaveLength(1);
        expect(lost).toHaveLength(1);
        const reason: unknown = lost[0]?.reason;
        expect(isAppError(reason) && reason.error, `第 ${String(round)} 轮`).toBe(
          "APPROVAL_NOT_PENDING",
        );

        const status = won[0]?.value.status ?? "";
        winners.push(status);
        const trace = await world.sample.trace(approvalId);
        expect(trace).toMatchObject({ status, transitions: 2, audits: 2 });
        expect(trace.events).toEqual(["approval.submitted", `approval.${status}`]);
        const domain = trace.domain;
        expect((domain?.approved ?? 0) + (domain?.rejected ?? 0) + (domain?.withdrawn ?? 0)).toBe(
          1,
        );
      }
      const tally = Object.entries(
        winners.reduce<Record<string, number>>(
          (counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }),
          {},
        ),
      )
        .map(([status, count]) => `${status} ${String(count)}`)
        .join("、");
      process.stdout.write(
        `[approval 并发] ${name} ${String(ROUNDS)} 轮：每轮 1 成功 / 1 被拒（${tally}）\n`,
      );
    },
    SLOW,
  );
});
