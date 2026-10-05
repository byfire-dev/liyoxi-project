import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import { assertSnapshotsEqual, snapshotTables, useSeededDatabase } from "../../testing/index.js";
import {
  createLedgerHarness,
  dumpLedger,
  openTerm,
  ownerContext,
  topUp,
} from "../testing/index.js";
import type { LedgerHarness } from "../testing/index.js";
import { LedgerError } from "./index.js";

// 账户与批次的单连接用例：账本时钟、月度发放与加购入账的重放、写入时自检。并发的那几条在 *.concurrency.test.ts。

const SLOW = 120_000;
const LEDGER_TABLES = [
  "billing_account",
  "subscription_term",
  "subscription_event",
  "grant_schedule",
  "point_lot",
  "ledger_operation",
  "point_ledger_entry",
  "outbox_event",
];
const at = (local: string): Date => new Date(`${local}+08:00`);

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: LedgerHarness;

beforeAll(async () => {
  prisma = await db.prisma();
  h = createLedgerHarness(prisma);
}, SLOW);

const refusal = async (run: Promise<unknown>): Promise<string | undefined> =>
  run.then(
    () => undefined,
    (error: unknown) =>
      error instanceof LedgerError ? error.reason : `不是账本错误：${String(error)}`,
  );

describe("账本时钟", () => {
  it(
    "拿到锁之后取注入的时钟，与上一次操作的时刻取较大者：时钟回拨，流水的时刻也不倒退",
    async () => {
      h.clock.set(at("2026-03-10T10:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      await topUp(h, { entityId: entity.id, points: 1000 });
      h.clock.set(at("2026-03-10T09:00:00"));
      await topUp(h, { entityId: entity.id, points: 2000 });

      const { operations, entries } = await dumpLedger(prisma, entity.id);
      expect(operations.map((op) => op.occurredAt)).toEqual([
        "2026-03-10T02:00:00.000Z",
        "2026-03-10T02:00:00.000Z",
      ]);
      expect(entries.map((entry) => entry.bizDate)).toEqual(["2026-03-10", "2026-03-10"]);
      const account = await prisma.billingAccount.findUniqueOrThrow({
        where: { entityId: entity.id },
      });
      expect(account.lastOpAt?.toISOString()).toBe("2026-03-10T02:00:00.000Z");
    },
    SLOW,
  );

  it(
    "同一事务再次进入用同一把锁、同一个时钟：中途拨时钟，两次操作的时刻相同",
    async () => {
      h.clock.set(at("2026-03-11T10:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      const [a, b] = [
        await h.make.billingOrder({ entityId: entity.id, type: "topup", amountFen: 100 }),
        await h.make.billingOrder({ entityId: entity.id, type: "topup", amountFen: 200 }),
      ];
      const ctx = ownerContext(entity.id, entity.createdByUserId);
      const clocks = await h.tx.run(async (tx) => {
        const first = await h.ledger.lockAccount(tx, entity.id);
        await h.ledger.purchase(tx, {
          entityId: entity.id,
          billingOrderId: a.id,
          points: 1,
          payFen: 100,
          ctx,
        });
        h.clock.advance(5_000);
        await h.ledger.purchase(tx, {
          entityId: entity.id,
          billingOrderId: b.id,
          points: 2,
          payFen: 200,
          ctx,
        });
        return [first, await h.ledger.lockAccount(tx, entity.id)];
      });
      expect(clocks[1]).toEqual(clocks[0]);
      expect(clocks[0]).toMatchObject({ entityId: entity.id, today: "2026-03-11" });
      const { operations } = await dumpLedger(prisma, entity.id);
      expect(new Set(operations.map((op) => op.occurredAt))).toEqual(
        new Set(["2026-03-11T02:00:00.000Z"]),
      );
      expect(operations.map((op) => op.actorType)).toEqual(["merchant", "merchant"]);
    },
    SLOW,
  );

  it(
    "主体还没有计费账户行：进入时补建",
    async () => {
      const entity = await h.make.entity();
      expect(await prisma.billingAccount.count({ where: { entityId: entity.id } })).toBe(0);
      await h.tx.run((tx) => h.ledger.advance(tx, entity.id));
      expect(
        await prisma.billingAccount.findUnique({ where: { entityId: entity.id } }),
      ).toMatchObject({ subStatus: "none", planAvailableQty: 0 });
      // 再调 ensureAccount 不报错、不重复
      await h.tx.run((tx) => h.ledger.ensureAccount(tx, entity.id));
      expect(await prisma.billingAccount.count({ where: { entityId: entity.id } })).toBe(1);
    },
    SLOW,
  );
});

describe("月度发放 grant", () => {
  it(
    "首月由调用方发：记在给定的操作人名下；同一行再发是重放，返回第一次的结果，什么都不写",
    async () => {
      h.clock.set(at("2026-03-12T10:00:00"));
      const { entity, user } = await h.make.merchant({ verified: true });
      const { schedules } = await openTerm(h, {
        entityId: entity.id,
        months: 3,
        ctx: ownerContext(entity.id, user.id),
      });
      const [first, second] = schedules;
      const operation = await prisma.ledgerOperation.findUniqueOrThrow({
        where: { opKey: `grant:grant_schedule:${first?.id}` },
      });
      expect(operation).toMatchObject({ actorType: "merchant", actorId: user.id, client: "weapp" });

      const before = await snapshotTables(prisma, LEDGER_TABLES);
      const again = await h.tx.run((tx) =>
        h.ledger.grant(tx, { grantScheduleId: first?.id as string }),
      );
      expect(again).toEqual({
        operationId: operation.id,
        pointLotId: first?.pointLotId,
        points: 6600,
        replayed: true,
      });
      assertSnapshotsEqual(before, await snapshotTables(prisma, LEDGER_TABLES));

      // 没到应发时刻的月份不给发；不存在的计划也拒
      expect(
        await refusal(
          h.tx.run((tx) => h.ledger.grant(tx, { grantScheduleId: second?.id as string })),
        ),
      ).toBe("guard");
      expect(
        await refusal(h.tx.run((tx) => h.ledger.grant(tx, { grantScheduleId: entity.id }))),
      ).toBe("guard");
      assertSnapshotsEqual(before, await snapshotTables(prisma, LEDGER_TABLES));
    },
    SLOW,
  );
});

describe("加购入账 purchase", () => {
  it(
    "新建长期有效的加购批次，成本 = 实付；发一条 purchased；同一张付款单再入账是重放",
    async () => {
      h.clock.set(at("2026-03-13T10:00:00"));
      const { entity, user } = await h.make.merchant({ verified: true });
      await openTerm(h, { entityId: entity.id });
      const first = await topUp(h, {
        entityId: entity.id,
        points: 3000,
        ctx: ownerContext(entity.id, user.id),
      });
      expect(first.replayed).toBe(false);

      const state = await dumpLedger(prisma, entity.id);
      expect(state.account).toMatchObject({ planAvailableQty: 6600, addonAvailableQty: 3000 });
      expect(state.lots.at(-1)).toEqual({
        kind: "addon",
        sourceType: "purchase",
        termNo: null,
        grantedAt: "2026-03-13T02:00:00.000Z",
        bizDate: "2026-03-13",
        expiresAt: null,
        originalQty: 3000,
        availableQty: 3000,
        heldQty: 0,
        expiredQty: 0,
        costBasisFen: 300_000,
      });
      expect(state.operations.at(-1)).toMatchObject({
        opType: "purchase",
        refType: "billing_order",
        planDeltaQty: 0,
        addonDeltaQty: 3000,
        spendableAfterQty: 9600,
        titleCode: "topup",
        actorType: "merchant",
      });
      const event = await prisma.outboxEvent.findFirstOrThrow({
        where: { entityId: entity.id, eventType: "billing.points.purchased" },
      });
      expect(event).toMatchObject({
        aggregateType: "billing_account",
        aggregateId: entity.id,
        dedupeKey: `ledger:purchase:billing_order:${first.billingOrderId}`,
        payload: { v: 1, entityId: entity.id, billingOrderId: first.billingOrderId, points: 3000 },
      });

      const other = await h.make.merchant();
      const foreign = await h.make.billingOrder({ entityId: other.entity.id, type: "topup" });
      const before = await snapshotTables(prisma, LEDGER_TABLES);
      const input = {
        entityId: entity.id,
        billingOrderId: first.billingOrderId,
        points: 3000,
        payFen: 300_000,
        ctx: ownerContext(entity.id, user.id),
      };
      const again = await h.tx.run((tx) => h.ledger.purchase(tx, input));
      expect(again).toEqual({ ...first, billingOrderId: undefined, replayed: true });
      // 同一张付款单换了数量：拒绝，不当成重放
      expect(
        await refusal(h.tx.run((tx) => h.ledger.purchase(tx, { ...input, points: 5000 }))),
      ).toBe("op_key_conflict");
      // 别的主体的付款单：拒绝
      expect(
        await refusal(
          h.tx.run((tx) => h.ledger.purchase(tx, { ...input, billingOrderId: foreign.id })),
        ),
      ).toBe("guard");
      assertSnapshotsEqual(before, await snapshotTables(prisma, LEDGER_TABLES));
    },
    SLOW,
  );
});

describe("写入时自检", () => {
  it(
    "账户缓存与批次对不上：操作抛错回滚，一行都不落；改回来之后同一个键照常入账",
    async () => {
      h.clock.set(at("2026-03-14T10:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      await openTerm(h, { entityId: entity.id });
      await prisma.billingAccount.update({
        where: { entityId: entity.id },
        data: { planAvailableQty: { increment: 1 } },
      });
      const order = await h.make.billingOrder({
        entityId: entity.id,
        type: "topup",
        amountFen: 100,
      });
      const input = {
        entityId: entity.id,
        billingOrderId: order.id,
        points: 1,
        payFen: 100,
        ctx: ownerContext(entity.id, entity.createdByUserId),
      };
      const before = await snapshotTables(prisma, LEDGER_TABLES);
      expect(await refusal(h.tx.run((tx) => h.ledger.purchase(tx, input)))).toBe("self_check");
      assertSnapshotsEqual(before, await snapshotTables(prisma, LEDGER_TABLES));

      await prisma.billingAccount.update({
        where: { entityId: entity.id },
        data: { planAvailableQty: { decrement: 1 } },
      });
      expect((await h.tx.run((tx) => h.ledger.purchase(tx, input))).replayed).toBe(false);
    },
    SLOW,
  );
});
