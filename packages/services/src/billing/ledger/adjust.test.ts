import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import { createIdentityContext, isAppError, uuidv7 } from "../../kernel/index.js";
import {
  adjustPoints,
  assertSnapshotsEqual,
  createLedgerHarness,
  dumpLedger,
  holdDrama,
  openTerm,
  snapshotTables,
  topUp,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness } from "../../testing/index.js";
import { LedgerError } from "./index.js";

// 手动调整（增、减）与过期后重新开通的加购恢复。调整只交账本函数：审批执行器与申请单在 M4。

const SLOW = 180_000;
const TABLES = [
  "billing_account",
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

async function subscribed(months = 1) {
  const { entity, store } = await h.make.merchant({ verified: true });
  const { term } = await openTerm(h, { entityId: entity.id, months });
  return { entityId: entity.id, storeId: store.id, term };
}
const refusalOf = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => "没有被拒",
    (error: unknown) =>
      isAppError(error) ? error.error : error instanceof LedgerError ? error.reason : error,
  );

describe("手动调整 adjust", () => {
  it(
    "增加：套餐积分归入当前周期、随本期清零，加购积分长期有效；都是无对价的新批次。发一条 adjusted",
    async () => {
      h.clock.set(at("2026-01-05T12:00:00"));
      const who = await subscribed();
      const ids = { approvalRequestId: uuidv7(), pointAdjustmentRequestId: uuidv7() };
      const staff = await h.make.staff();
      const ctx = createIdentityContext({
        actor: { type: "staff", id: staff.id, client: "admin" },
        entityId: who.entityId,
      });
      const plan = await h.tx.run((tx) =>
        h.ledger.adjust(tx, {
          ...ids,
          entityId: who.entityId,
          requestNo: "TZ20260105001",
          direction: "increase",
          lotKind: "plan",
          points: 660,
          reasonCode: "compensation",
          note: "交付超时补偿",
          ctx,
        }),
      );
      expect(plan).toMatchObject({ deltaPoints: 660, replayed: false });
      const addon = await adjustPoints(h, {
        ...who,
        direction: "increase",
        lotKind: "addon",
        points: 200,
      });

      let state = await dumpLedger(prisma, who.entityId);
      expect(state.account).toMatchObject({ planAvailableQty: 7260, addonAvailableQty: 200 });
      expect(state.lots.filter((lot) => lot.sourceType === "adjust")).toMatchObject([
        {
          kind: "plan",
          sourceType: "adjust",
          termNo: 1,
          expiresAt: who.term.endsAt.toISOString(),
          originalQty: 660,
          costBasisFen: 0,
        },
        {
          kind: "addon",
          sourceType: "adjust",
          termNo: null,
          expiresAt: null,
          originalQty: 200,
          costBasisFen: 0,
        },
      ]);
      expect(
        await prisma.pointLot.findUniqueOrThrow({ where: { id: plan.pointLotId as string } }),
      ).toMatchObject({ sourceId: ids.approvalRequestId, planId: who.term.planId });
      const operation = await prisma.ledgerOperation.findUniqueOrThrow({
        where: { id: plan.operationId },
      });
      expect(operation).toMatchObject({
        opKey: "adjust:TZ20260105001",
        opType: "adjust",
        refType: "approval_request",
        refId: ids.approvalRequestId,
        planDeltaQty: 660,
        addonDeltaQty: 0,
        spendableAfterQty: 7260,
        titleCode: "adjust",
        titleArgs: { reasonCode: "compensation", note: "交付超时补偿" },
        actorType: "staff",
        actorId: staff.id,
      });
      expect(
        await prisma.outboxEvent.findFirstOrThrow({
          where: { entityId: who.entityId, eventType: "billing.points.adjusted" },
        }),
      ).toMatchObject({
        dedupeKey: "ledger:adjust:TZ20260105001",
        payload: {
          v: 1,
          entityId: who.entityId,
          pointAdjustmentRequestId: ids.pointAdjustmentRequestId,
          deltaPoints: 660,
        },
      });
      expect(addon.pointLotId).not.toBeNull();

      // 调整增加的套餐积分随本期清零；加购的留着（停用）
      h.clock.set(who.term.endsAt);
      await h.tx.run((tx) => h.ledger.advance(tx, who.entityId));
      state = await dumpLedger(prisma, who.entityId);
      expect(state.account).toMatchObject({
        subStatus: "expired",
        planAvailableQty: 0,
        addonAvailableQty: 200,
        lastExpiredQty: 7260,
      });
    },
    SLOW,
  );

  it(
    "扣减：从指定类型的批次按扣减顺序移到“调整扣减”；不够不入账（PRECONDITION_CHANGED），冻结中的不算可扣",
    async () => {
      h.clock.set(at("2026-03-05T12:00:00"));
      const who = await subscribed(3);
      await topUp(h, { entityId: who.entityId, points: 1000 });
      h.clock.set(at("2026-04-05T09:00:00"));
      // 两个套餐批次各 6,600：扣 7,000 = 先入账的取满，再取 400
      const cut = await adjustPoints(h, {
        ...who,
        direction: "decrease",
        lotKind: "plan",
        points: 7000,
      });
      expect(cut).toMatchObject({ deltaPoints: -7000, pointLotId: null, replayed: false });
      let state = await dumpLedger(prisma, who.entityId);
      expect(state.lots.map((lot) => [lot.kind, lot.availableQty])).toEqual([
        ["plan", 0],
        ["addon", 1000],
        ["plan", 6200],
      ]);
      expect(state.lotBuckets.map((lot) => lot.adjustedOutQty)).toEqual([6600, 0, 400]);
      expect(state.operations.at(-1)).toMatchObject({
        opType: "adjust",
        planDeltaQty: -7000,
        addonDeltaQty: 0,
        spendableAfterQty: 7200,
      });
      expect(state.entries.slice(-2)).toMatchObject([
        { lotKind: "plan", fromBucket: "available", toBucket: "adjusted_out", qty: 6600 },
        { lotKind: "plan", fromBucket: "available", toBucket: "adjusted_out", qty: 400 },
      ]);

      // 冻结 1,800 之后套餐可用只剩 4,400：扣 4,401 不够，扣加购 1,001 也不够；都不落一行
      const drama = await h.make.drama({ heatTier: "A" });
      await holdDrama(h, { ...who, dramaId: drama.id });
      const before = await snapshotTables(prisma, TABLES);
      const short = await adjustPoints(h, {
        ...who,
        direction: "decrease",
        lotKind: "plan",
        points: 4401,
      }).catch((error: unknown) => error);
      expect(short).toMatchObject({
        error: "PRECONDITION_CHANGED",
        details: { requiredPoints: 4401, availablePoints: 4400 },
      });
      expect(
        await refusalOf(
          adjustPoints(h, { ...who, direction: "decrease", lotKind: "addon", points: 1001 }),
        ),
      ).toBe("PRECONDITION_CHANGED");
      assertSnapshotsEqual(before, await snapshotTables(prisma, TABLES));
      await adjustPoints(h, { ...who, direction: "decrease", lotKind: "addon", points: 1000 });
      state = await dumpLedger(prisma, who.entityId);
      expect(state.account).toMatchObject({
        planAvailableQty: 4400,
        addonAvailableQty: 0,
        heldTotalQty: 1800,
      });
    },
    SLOW,
  );

  it(
    "守卫：已过期的账户不能调整；数量须是正整数；平台原因退回不走调整",
    async () => {
      h.clock.set(at("2026-05-05T12:00:00"));
      const who = await subscribed();
      const never = await h.make.merchant({ verified: true });
      const input = { ...who, direction: "increase", lotKind: "addon", points: 10 } as const;
      expect(await refusalOf(adjustPoints(h, { ...input, points: 0 }))).toBe("guard");
      expect(await refusalOf(adjustPoints(h, { ...input, points: 1.5 }))).toBe("guard");
      expect(
        await refusalOf(
          h.tx.run((tx) =>
            h.ledger.adjust(tx, {
              entityId: who.entityId,
              approvalRequestId: uuidv7(),
              requestNo: `TZ-${uuidv7()}`,
              pointAdjustmentRequestId: uuidv7(),
              direction: "increase",
              lotKind: "addon",
              points: 10,
              reasonCode: "platform_refund",
              ctx: createIdentityContext({
                actor: { type: "system", job: "lyxtest.adjust" },
                entityId: who.entityId,
              }),
            }),
          ),
        ),
      ).toBe("guard");
      expect(await refusalOf(adjustPoints(h, { ...input, entityId: never.entity.id }))).toBe(
        "SUBSCRIPTION_INACTIVE",
      );
      h.clock.set(at("2026-06-06T12:00:00"));
      expect(await refusalOf(adjustPoints(h, input))).toBe("SUBSCRIPTION_INACTIVE");
    },
    SLOW,
  );
});

describe("加购积分恢复 addon_resume", () => {
  it(
    "过期后重新开通：发完首月记一行恢复，可花 = 新一期的套餐积分 + 停用过的加购积分；再记是重放；别的周期不给记",
    async () => {
      h.clock.set(at("2026-07-05T12:00:00"));
      const who = await subscribed();
      await topUp(h, { entityId: who.entityId, points: 1000 });
      h.clock.set(at("2026-08-10T12:00:00"));
      await h.tx.run((tx) => h.ledger.advance(tx, who.entityId));
      expect((await dumpLedger(prisma, who.entityId)).operations.at(-1)).toMatchObject({
        opType: "addon_suspend",
        spendableAfterQty: 0,
      });

      // 夹具照履约的做法：建周期（origin = resume）、账户置为生效、发首月、记加购恢复
      const { term } = await openTerm(h, { entityId: who.entityId });
      expect(term.origin).toBe("resume");
      const state = await dumpLedger(prisma, who.entityId);
      expect(state.operations.slice(-2)).toMatchObject([
        { opType: "grant", planDeltaQty: 6600, spendableAfterQty: 7600, titleCode: "grant_open" },
        {
          opType: "addon_resume",
          refType: "subscription_term",
          planDeltaQty: 0,
          addonDeltaQty: 0,
          spendableAfterQty: 7600,
          titleCode: "addon_resume",
          occurredAt: h.clock.now().toISOString(),
          bizDate: "2026-08-10",
        },
      ]);
      const operation = await prisma.ledgerOperation.findFirstOrThrow({
        where: { entityId: who.entityId, opType: "addon_resume" },
      });
      expect(operation).toMatchObject({
        opKey: `resume:subscription_term:${term.id}:2026-09-09`,
        refId: term.id,
        titleArgs: { termEndDate: "2026-09-09" },
      });
      // 只写账本操作，不另发事件
      expect(
        await prisma.outboxEvent.count({
          where: { entityId: who.entityId, eventType: { startsWith: "billing.subscription.res" } },
        }),
      ).toBe(0);

      const fresh = await subscribed();
      const before = await snapshotTables(prisma, TABLES);
      expect(
        await h.tx.run((tx) => h.ledger.resumeAddon(tx, { subscriptionTermId: term.id })),
      ).toEqual({ operationId: operation.id, replayed: true });
      // 首次开通的、续接的周期不是“过期后重新开通”
      expect(
        await refusalOf(
          h.tx.run((tx) => h.ledger.resumeAddon(tx, { subscriptionTermId: fresh.term.id })),
        ),
      ).toBe("guard");
      expect(
        await refusalOf(
          h.tx.run((tx) => h.ledger.resumeAddon(tx, { subscriptionTermId: uuidv7() })),
        ),
      ).toBe("guard");
      assertSnapshotsEqual(before, await snapshotTables(prisma, TABLES));
    },
    SLOW,
  );
});
