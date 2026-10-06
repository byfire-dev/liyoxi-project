import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isAppError, uuidv7 } from "../../kernel/index.js";
import {
  createLedgerHarness,
  dramaHoldInput,
  dumpLedger,
  openTerm,
  priceDrama,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness } from "../../testing/index.js";
import { billingInvariants } from "../invariants.js";
import type { CaptureResult, HoldResult } from "./index.js";

// 验收 2、3（甲类的并发测试）。
// 验收 2：同一主体 20 个并发冻结，各用各的连接、栅栏对齐后同时进账本，合计需求超过余额，重复 20 轮——
//   成功的合计 ≤ 余额；没成的都是 POINTS_INSUFFICIENT，且它要的比最后剩的多（不是该成而没成）；
//   账户与批次无负数；billing.I3、I4 成立。
// 验收 3：同一个键 20 个并发 hold、capture，各只生效一次，其余拿到同一结果。
// 等锁上限 3 秒：机器忙时排在后面的会等超时，ACCOUNT_BUSY 是可重试的，这里照端上的做法重试。

const SLOW = 300_000;
const CROWD = 20;
const ROUNDS = 20;
const at = (local: string): Date => new Date(`${local}+08:00`);

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: LedgerHarness;
/** 连接数上限 20 的另一个客户端：20 个并发事务各占一条独立连接 */
let wide: PrismaClient;
let crowd: LedgerHarness;
let staffId: string;

beforeAll(async () => {
  prisma = await db.prisma();
  h = createLedgerHarness(prisma);
  wide = createPrismaClient({ connectionString: await db.url(), max: CROWD });
  crowd = createLedgerHarness(wide, { clock: h.clock });
  staffId = (await h.make.staff()).id;
}, SLOW);

afterAll(async () => {
  await wide?.$disconnect();
});

/** 栅栏：n 方都到了才一起放行 */
function fence(n: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return async () => {
    arrived += 1;
    if (arrived >= n) open();
    await opened;
  };
}

/** n 方并发各开一个事务（各占一条连接），都开好了再同时调账本；等锁超时照端上的做法重试 */
async function together<T>(
  n: number,
  run: (index: number, tx: Parameters<Parameters<LedgerHarness["tx"]["run"]>[0]>[0]) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const aligned = fence(n);
  const attempt = async (index: number): Promise<T> => {
    for (let tries = 0; ; tries += 1) {
      try {
        return await crowd.tx.run(
          async (tx) => {
            await tx.$queryRaw`SELECT 1`;
            await aligned();
            return run(index, tx);
          },
          { timeoutMs: 60_000 },
        );
      } catch (error) {
        if (!(isAppError(error) && error.error === "ACCOUNT_BUSY") || tries >= 20) throw error;
      }
    }
  };
  return Promise.allSettled(Array.from({ length: n }, (_, index) => attempt(index)));
}

async function subscribed() {
  const { entity, store } = await h.make.merchant({ verified: true });
  await openTerm(h, { entityId: entity.id });
  return { entityId: entity.id, storeId: store.id };
}
async function dramaPriced(points: number): Promise<string> {
  const drama = await h.make.drama({ heatTier: "A" });
  await priceDrama(h, { dramaId: drama.id, points, staffId });
  return drama.id;
}
const violations = async (code: string, entityId: string) => {
  const check = billingInvariants.find((item) => item.code === code);
  return h.tx.run(
    async (tx) => (await check?.run?.(tx, { entityIds: [entityId] }, { now: h.clock.now() })) ?? [],
  );
};

describe("并发冻结（验收 2）", () => {
  it(
    `同一主体 ${String(CROWD)} 个并发冻结、合计超过余额，重复 ${String(ROUNDS)} 轮：成功的合计不超余额，无负数，I3、I4 成立`,
    async () => {
      h.clock.set(at("2026-01-05T12:00:00"));
      // 专业版 9 折：450 与 1,080 两种应扣；20 个合计 15,300，余额 6,600
      const dramas = [await dramaPriced(500), await dramaPriced(1200)];
      const BALANCE = 6600;
      for (let round = 0; round < ROUNDS; round += 1) {
        const who = await subscribed();
        const outcomes = await together(CROWD, (index, tx) =>
          crowd.ledger.hold(
            tx,
            dramaHoldInput({ ...who, dramaId: dramas[index % 2] as string, refId: uuidv7() }),
          ),
        );
        const won = outcomes.flatMap((outcome) =>
          outcome.status === "fulfilled" ? [outcome.value] : [],
        );
        const lost = outcomes.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason as unknown] : [],
        );
        const taken = won.reduce((sum, held) => sum + held.points, 0);
        const left = BALANCE - taken;
        const label = `第 ${String(round + 1)} 轮`;
        expect(won.length, label).toBeGreaterThan(0);
        expect(lost.length, label).toBeGreaterThan(0);
        expect(taken, label).toBeLessThanOrEqual(BALANCE);
        for (const error of lost) {
          expect(isAppError(error) && error.error, label).toBe("POINTS_INSUFFICIENT");
          const details = (error as { details: Record<string, number> }).details;
          // 它要的比最后剩的多：不是该成而没成；它当时看到的可用不少于最后剩的
          expect(details["requiredPoints"], label).toBeGreaterThan(left);
          expect(details["spendablePoints"], label).toBeGreaterThanOrEqual(left);
        }
        const state = await dumpLedger(prisma, who.entityId);
        expect(state.account, label).toMatchObject({
          planAvailableQty: left,
          addonAvailableQty: 0,
          heldTotalQty: taken,
        });
        expect(state.lots, label).toMatchObject([{ availableQty: left, heldQty: taken }]);
        expect(state.holds, label).toHaveLength(won.length);
        expect(await violations("billing.I3", who.entityId), label).toEqual([]);
        expect(await violations("billing.I4", who.entityId), label).toEqual([]);
      }
    },
    SLOW,
  );
});

describe("同一个键的并发（验收 3）", () => {
  it(
    `同一个业务引用 ${String(CROWD)} 个并发 hold、同一张冻结单 ${String(CROWD)} 个并发 capture：各只生效一次，其余拿到同一结果`,
    async () => {
      h.clock.set(at("2026-02-05T12:00:00"));
      const who = await subscribed();
      const input = dramaHoldInput({ ...who, dramaId: await dramaPriced(2000), refId: uuidv7() });
      const settled = <T>(outcomes: PromiseSettledResult<T>[]): T[] =>
        outcomes.map((outcome) => {
          if (outcome.status === "rejected") throw outcome.reason;
          return outcome.value;
        });

      const holds: HoldResult[] = settled(
        await together(CROWD, (_, tx) => crowd.ledger.hold(tx, input)),
      );
      expect(holds.filter((held) => !held.replayed)).toHaveLength(1);
      const [first] = holds as [HoldResult];
      for (const held of holds)
        expect({ ...held, replayed: false }).toEqual({ ...first, replayed: false });

      const captures: CaptureResult[] = settled(
        await together(CROWD, (_, tx) =>
          crowd.ledger.capture(tx, {
            pointHoldId: first.pointHoldId,
            title: { refType: "order_item", refNo: "LYX-TEST", count: 1 },
            ctx: input.ctx,
          }),
        ),
      );
      expect(captures.filter((captured) => !captured.replayed)).toHaveLength(1);
      expect(new Set(captures.map((captured) => captured.operationId)).size).toBe(1);

      const state = await dumpLedger(prisma, who.entityId);
      expect(state.holds).toMatchObject([{ status: "captured", qty: 1800 }]);
      expect(state.operations.map((op) => op.opType)).toEqual(["grant", "hold", "capture"]);
      expect(state.account).toMatchObject({ planAvailableQty: 4800, heldTotalQty: 0 });
      expect(state.lotBuckets).toMatchObject([{ consumedQty: 1800 }]);
      expect(
        await prisma.outboxEvent.count({
          where: {
            entityId: who.entityId,
            eventType: { in: ["billing.points.held", "billing.points.captured"] },
          },
        }),
      ).toBe(2);
    },
    SLOW,
  );
});
