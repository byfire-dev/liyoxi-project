import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createLedgerHarness,
  dumpLedger,
  joinLedger,
  openTerm,
  ownerContext,
  topUp,
  useSeededDatabase,
} from "../../testing/index.js";
import { billingInvariants } from "../invariants.js";
import { advanceDueAccounts } from "../sweep.js";
import type { LedgerHarness } from "../../testing/index.js";

// 验收 8（甲类的并发测试）：推进的并发。
//   ① 两个扫描并行：每个周期每月恰发放一次、清零一次，无死锁；期间有加购入账穿插。
//   ② 事务跨零点等锁：事务在零点前开始、阻塞在账户锁上，零点后扫描做完清零与接续才放行——
//      它的流水的 occurred_at、biz_date 在零点之后，用到的只有新周期的积分，billing.I16 成立。
// 冻结（hold）与清零落在同一时刻的那一条随冻结一族补：这里用加购入账走同一个入口。

const SLOW = 180_000;
const at = (local: string): Date => new Date(`${local}+08:00`);

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: LedgerHarness;
let other: Awaited<ReturnType<typeof joinLedger>>;

beforeAll(async () => {
  prisma = await db.prisma();
  h = createLedgerHarness(prisma);
  other = await joinLedger(h, await db.url());
}, SLOW);

afterAll(async () => {
  await other?.close();
});

const sweep = (side: LedgerHarness) =>
  advanceDueAccounts({ db: side.prisma, tx: side.tx, clock: side.clock, ledger: side.ledger });

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe("推进的并发（验收 8）", () => {
  it(
    "两个扫描并行、加购穿插：每个周期每月恰发放一次、清零一次，没有死锁，两边都不报错",
    async () => {
      h.clock.set(at("2026-01-05T12:00:00"));
      const entities: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        const { entity } = await h.make.merchant({ verified: true });
        // 季付一期，后面接一个月付的预约周期：01-05 至 04-04，04-05 至 05-04
        const first = await openTerm(h, { entityId: entity.id, months: 3 });
        await openTerm(h, { entityId: entity.id, after: first.term });
        entities.push(entity.id);
      }

      // 四个时刻各扫一轮：第 2、3 个月的发放日；清零加接续；再到期
      const moments = [
        "2026-02-05T00:00:20",
        "2026-03-05T00:00:20",
        "2026-04-05T00:00:20",
        "2026-05-05T00:00:20",
      ];
      for (const moment of moments) {
        h.clock.set(at(moment));
        const [a, b] = await Promise.all([
          sweep(h),
          sweep(other),
          // 同时有人加购：与扫描抢同一把账户锁
          ...entities.slice(0, 3).map((entityId) => topUp(h, { entityId, points: 100 })),
        ]);
        expect([...a.failed, ...b.failed]).toEqual([]);
        // 被对方或加购占着而跳过的，再扫一轮收尾；之后没有到点未处理的主体
        const rest = await sweep(h);
        expect(rest.failed).toEqual([]);
        expect((await sweep(other)).due).toBe(0);
      }

      for (const entityId of entities) {
        const state = await dumpLedger(prisma, entityId);
        const count = (opType: string): number =>
          state.operations.filter((op) => op.opType === opType).length;
        expect(count("grant")).toBe(4);
        expect(count("expire")).toBe(2);
        expect(count("addon_suspend")).toBe(1);
        expect(state.schedules.map((row) => row.status)).toEqual(Array(4).fill("granted"));
        expect(state.subscriptionEvents.map((event) => event.type)).toEqual([
          "rolled_over",
          "expired",
        ]);
        expect(state.account).toMatchObject({ subStatus: "expired", planAvailableQty: 0 });
        expect(state.lots.filter((lot) => lot.kind === "plan")).toHaveLength(4);
      }
      // 事件不重发：发放按发放计划去重，清零按周期去重
      const events = await prisma.outboxEvent.groupBy({
        by: ["eventType"],
        where: { entityId: { in: entities }, eventType: { startsWith: "billing." } },
        _count: true,
      });
      expect(Object.fromEntries(events.map((row) => [row.eventType, row._count]))).toMatchObject({
        "billing.points.granted": 32,
        "billing.points.expired": 16,
        "billing.subscription.rolled_over": 8,
        "billing.subscription.expired": 8,
      });
    },
    SLOW,
  );

  it(
    "事务跨零点等锁：零点前开始、零点后才拿到锁——时刻取拿锁之后的，先清零接续，再记在新一天、新周期上",
    async () => {
      h.clock.set(at("2026-06-10T12:00:00"));
      const { entity, user } = await h.make.merchant({ verified: true });
      const first = await openTerm(h, { entityId: entity.id });
      await openTerm(h, { entityId: entity.id, after: first.term, planCode: "basic" });
      // 这一期到 07-09，止点 07-10 00:00
      const midnight = at("2026-07-10T00:00:00");
      expect(first.term.endsAt).toEqual(midnight);

      h.clock.set(at("2026-07-09T23:59:59.500"));
      const locked = gate();
      const release = gate();
      // 另一条连接先占住账户行（还没进入账本，没取时钟）
      const sweeper = other.tx.run(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM billing_account WHERE entity_id = ${entity.id}::uuid FOR UPDATE`;
          locked.open();
          await release.opened;
          // 零点之后：扫描做清零、接续、发首月
          return other.ledger.advance(tx, entity.id);
        },
        { timeoutMs: 30_000 },
      );
      await locked.opened;

      // 零点前开始的加购：记下它“开始的时刻”，然后阻塞在账户锁上
      const startedAt = h.clock.now();
      const order = await h.make.billingOrder({
        entityId: entity.id,
        type: "topup",
        amountFen: 50_000,
      });
      const purchase = h.tx.run((tx) =>
        h.ledger.purchase(tx, {
          entityId: entity.id,
          billingOrderId: order.id,
          points: 500,
          payFen: 50_000,
          ctx: ownerContext(entity.id, user.id),
        }),
      );
      // 等它真的排到锁上（至多等 5 秒；没等到也不影响结论：它的时钟反正是拿到锁之后才取）
      for (let waited = 0; waited < 5_000; waited += 20) {
        const [queued] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_locks
          WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`;
        if ((queued?.waiting ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      h.clock.set(at("2026-07-10T00:00:00.400"));
      release.open();
      expect(await sweeper).toEqual({ granted: 1, expired: 1, rolledOver: 1, suspended: false });
      await purchase;

      expect(startedAt < midnight).toBe(true);
      const state = await dumpLedger(prisma, entity.id);
      expect(state.operations.slice(-3)).toMatchObject([
        { opType: "expire", occurredAt: "2026-07-09T16:00:00.000Z", bizDate: "2026-07-09" },
        { opType: "grant", occurredAt: "2026-07-09T16:00:00.000Z", bizDate: "2026-07-10" },
        {
          opType: "purchase",
          occurredAt: "2026-07-09T16:00:00.400Z",
          bizDate: "2026-07-10",
          // 可花里只有新周期的 3,000 与这次加购的 500：上一期的 6,600 已清零，用不到
          spendableAfterQty: 3500,
        },
      ]);
      expect(state.entries.at(-1)).toMatchObject({
        lotKind: "addon",
        occurredAt: "2026-07-09T16:00:00.400Z",
        bizDate: "2026-07-10",
      });
      expect(state.account).toMatchObject({ currentTermNo: 2, lastExpiredQty: 6600 });

      const i16 = billingInvariants.find((check) => check.code === "billing.I16");
      const violations = await h.tx.run(
        async (tx) =>
          (await i16?.run?.(tx, { entityIds: [entity.id] }, { now: h.clock.now() })) ?? [],
      );
      expect(violations).toEqual([]);
    },
    SLOW,
  );

  it(
    "恰在止点那一刻进入：先清零，这一刻入账的操作排在清零之后，上一期的积分不算可花",
    async () => {
      h.clock.set(at("2026-08-10T12:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      const { term } = await openTerm(h, { entityId: entity.id });
      h.clock.set(term.endsAt);
      await topUp(h, { entityId: entity.id, points: 200 });
      const { operations, account } = await dumpLedger(prisma, entity.id);
      expect(operations.slice(-3).map((op) => [op.opType, op.spendableAfterQty])).toEqual([
        ["expire", 0],
        ["addon_suspend", 0],
        ["purchase", 0],
      ]);
      expect(account).toMatchObject({ subStatus: "expired", addonAvailableQty: 200 });
    },
    SLOW,
  );
});
