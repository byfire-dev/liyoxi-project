import { beforeAll, expect, it } from "vitest";
import { calendarDate } from "@liyoxi/shared/time";
import {
  assertSnapshotsEqual,
  captureHold,
  createLedgerHarness,
  holdDrama,
  openTerm,
  priceDrama,
  refundHold,
  releaseHold,
  snapshotTables,
  topUp,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness } from "../../testing/index.js";
import { savepoint, uuidv7 } from "../../kernel/index.js";
import {
  BillingDailyHistoryMissingError,
  captureSubscriptionDailySnapshot,
  createBillingDailyProjection,
  rebuildEntityValuation,
} from "../index.js";
import { fromDateColumn, toDateColumn } from "../ledger/context.js";

const db = useSeededDatabase("services", { max: 1 });
const at = (local: string) => new Date(`${local}+08:00`);
let h: LedgerHarness;
beforeAll(async () => {
  h = createLedgerHarness(await db.prisma());
}, 120_000);

// 原公开账本fixture建周期且真实发积分；本片未接实际履约写者，单独追加其真实状态快照事实。
async function record(termId: string, entityId: string, type: "activated" | "renewal_scheduled") {
  return h.tx.run(async (tx) => {
    const clock = await h.ledger.lockAccount(tx, entityId);
    const dailySnapshot = await captureSubscriptionDailySnapshot(tx, entityId, termId);
    await tx.subscriptionEvent.create({
      data: {
        id: uuidv7(),
        entityId,
        subscriptionTermId: termId,
        type,
        toPlanId: dailySnapshot.planId,
        toPlanRevisionId: dailySnapshot.planRevisionId,
        payload: { dailySnapshot },
        occurredAt: clock.now,
        bizDate: toDateColumn(clock.today),
        actorType: "system",
        createdAt: clock.now,
      },
    });
    return dailySnapshot;
  });
}

it("真实流水与周期快照重建历史日：预约隔离、发放/冻结/冲回价值、conversion来源及legacy局部失败", async () => {
  h.clock.set(at("2040-01-01T12:00:00"));
  const who = await h.make.merchant({ verified: true });
  const entityId = who.entity.id;
  const { term } = await openTerm(h, { entityId, months: 3 });
  const initial = await record(term.id, entityId, "activated");
  const next = await openTerm(h, { entityId, after: term, planCode: "basic" });
  const scheduled = await record(next.term.id, entityId, "renewal_scheduled");
  expect(initial.pendingGrants.map((grant) => grant.valueFen)).toEqual([600_000, 600_000]);
  expect(scheduled.status).toBe("scheduled");
  const staff = await h.make.staff();
  const drama = await h.make.drama({ heatTier: "A" });
  await priceDrama(h, { dramaId: drama.id, points: 100, staffId: staff.id });
  const holdInput = { entityId, storeId: who.store.id, dramaId: drama.id };
  h.clock.set(at("2040-01-02T12:00:00"));
  const spent = await holdDrama(h, holdInput);
  expect(spent.points).toBe(90);
  await captureHold(h, spent.pointHoldId);
  await topUp(h, { entityId, points: 10 });
  h.clock.set(at("2040-01-03T12:00:00"));
  const held = await holdDrama(h, holdInput);
  h.clock.set(at("2040-01-04T12:00:00"));
  await refundHold(h, { pointHoldId: spent.pointHoldId, qty: spent.points });
  h.clock.set(at("2040-02-02T12:00:00"));
  await h.tx.run((tx) => h.ledger.advance(tx, entityId));
  const projection = createBillingDailyProjection({ ledger: h.ledger });
  const run = () => h.tx.run((tx) => projection.snapshot(tx, entityId, "2040-02-01"));
  await run();
  const daily = await h.prisma.billingEntityDaily.findMany({
    where: { entityId },
    orderBy: { bizDate: "asc" },
  });
  expect(daily).toHaveLength(32);
  const day = (date: string) => daily.find((row) => fromDateColumn(row.bizDate) === date)!;
  expect(day("2040-01-01")).toMatchObject({
    subStatus: "active",
    subscriptionTermId: term.id,
    planId: term.planId,
    mrrFen: 600_000,
    planAvailablePoints: 6600,
    addonAvailablePoints: 0,
    heldPoints: 0,
    liabilityPoints: 6600,
    liabilityValueFen: 600_000,
    deferredPlanFeeFen: 1_500_000,
  });
  // 独立手算floor(600000*90/6600)=8181；冻结不确认收入，冲回原消耗成本。
  expect(day("2040-01-02")).toMatchObject({
    planAvailablePoints: 6510,
    addonAvailablePoints: 10,
    heldPoints: 0,
    liabilityPoints: 6520,
    liabilityValueFen: 592_819,
  });
  expect(day("2040-01-03")).toMatchObject({
    planAvailablePoints: 6420,
    heldPoints: 90,
    liabilityPoints: 6520,
    liabilityValueFen: 592_819,
  });
  expect(day("2040-01-31")).toMatchObject({
    planAvailablePoints: 6510,
    heldPoints: 90,
    liabilityPoints: 6610,
    liabilityValueFen: 601_000,
    deferredPlanFeeFen: 1_500_000,
  });
  expect(day("2040-02-01")).toMatchObject({
    planAvailablePoints: 13_110,
    heldPoints: 90,
    liabilityPoints: 13_210,
    liabilityValueFen: 1_201_000,
    deferredPlanFeeFen: 900_000,
    subscriptionTermId: term.id,
    mrrFen: 600_000,
  });
  const derived = ["billing_entity_daily", "point_entry_valuation"];
  const before = await snapshotTables(h.prisma, derived);
  await run();
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, derived));
  await expect(
    h.tx.run(async (tx) => {
      const clock = await h.ledger.lockAccount(tx, entityId);
      await tx.subscriptionEvent.create({
        data: {
          id: uuidv7(),
          entityId,
          subscriptionTermId: term.id,
          type: "activated",
          payload: { dailySnapshot: scheduled },
          occurredAt: clock.now,
          bizDate: toDateColumn("2040-01-01"),
          actorType: "system",
          createdAt: clock.now,
        },
      });
      await projection.snapshot(tx, entityId, "2040-02-01");
    }),
  ).rejects.toThrow("BILLING_DAILY_HISTORY_SCOPE_INVALID");
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, derived));

  // 真实旧史缺snapshot：正式advance提交；projection保存点失败不产生半截派生行。
  const legacy = await h.make.merchant({ verified: true });
  const old = await openTerm(h, { entityId: legacy.entity.id });
  h.clock.set(old.term.endsAt);
  await h.tx.run(async (tx) => {
    await h.ledger.advance(tx, legacy.entity.id);
    await expect(
      savepoint(tx, () =>
        projection.snapshot(tx, legacy.entity.id, calendarDate(old.term.endDate)),
      ),
    ).rejects.toBeInstanceOf(BillingDailyHistoryMissingError);
  });
  expect(
    await h.prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: old.term.id } }),
  ).toMatchObject({ status: "ended" });
  expect(await h.prisma.billingEntityDaily.count({ where: { entityId: legacy.entity.id } })).toBe(
    0,
  );

  // 原周期过期后真实释放→conversion；价值来自原transfer_out，非null成本猜0。
  h.clock.set(term.endsAt);
  const returned = await releaseHold(h, held.pointHoldId, "platform");
  expect(returned.convertedPoints).toBe(90);
  const values = await h.tx.run((tx) => rebuildEntityValuation(tx, { ledger: h.ledger }, entityId));
  const converted = await h.prisma.pointLot.findFirstOrThrow({
    where: { entityId, sourceType: "conversion" },
  });
  expect(converted.costBasisFen).toBeNull();
  expect(
    values.find((row) => row.pointLedgerEntryId === converted.originPointLedgerEntryId),
  ).toMatchObject({ effect: "transfer_out", valueFen: 8182 });
  expect(
    values.find((row) => row.pointLotId === converted.id && row.effect === "inflow"),
  ).toMatchObject({ valueFen: 8182, remainingValueFen: 8182 });
}, 30_000);
