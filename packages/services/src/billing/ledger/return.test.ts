import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import { uuidv7 } from "../../kernel/index.js";
import {
  adjustPoints,
  assertSnapshotsEqual,
  captureHold,
  createLedgerHarness,
  dumpLedger,
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
import { HoldStateError, LedgerError } from "./index.js";

// 验收 6：冻结单状态与退回（表驱动）。07 分组 第 2.13 节状态表的 5 行逐行；退回从分摊序列的尾部取；
// 原周期已结束时按下单时快照里的去向：addon 转为加购积分（新批次指回原批次的那条转出流水），forfeit 记清零；
// 超过可退数量被拒。

const SLOW = 180_000;
const TABLES = [
  "billing_account",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
  "outbox_event",
];
const at = (local: string): Date => new Date(`${local}+08:00`);

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: LedgerHarness;
let staffId: string;

beforeAll(async () => {
  prisma = await db.prisma();
  h = createLedgerHarness(prisma);
  staffId = (await h.make.staff()).id;
}, SLOW);

async function subscribed() {
  const { entity, store } = await h.make.merchant({ verified: true });
  const { term } = await openTerm(h, { entityId: entity.id });
  return { entityId: entity.id, storeId: store.id, term };
}
async function dramaPriced(points: number): Promise<string> {
  const drama = await h.make.drama({ heatTier: "A" });
  await priceDrama(h, { dramaId: drama.id, points, staffId });
  return drama.id;
}
const statusOf = async (pointHoldId: string) =>
  (await prisma.pointHold.findUniqueOrThrow({ where: { id: pointHoldId } })).status;

type Status = "held" | "captured" | "refunded_partial" | "refunded_full" | "released";
type Event = "capture" | "release" | "refund_part" | "refund_rest" | "refund_over";
/** 迁移的结果：新状态；replay = 同一个键再来一次，返回原结果、什么都不写；其余是被拒的原因 */
type Outcome = Status | "replay" | "not_held" | "not_captured" | "exceeds_refundable";

// 07 分组 第 2.13 节的状态表。应扣 90；“部分退回”的起点是已退 30
const TRANSITIONS: readonly (readonly [Status, Event, Outcome])[] = [
  // 第 2、3 行：held --capture--> captured；held --release--> released
  ["held", "capture", "captured"],
  ["held", "release", "released"],
  ["held", "refund_part", "not_captured"],
  // 第 4 行：captured / refunded_partial --refund(qty)--> refunded_partial / refunded_full；qty ≤ 应扣 − 已退回 − 不予退回
  ["captured", "refund_part", "refunded_partial"],
  ["captured", "refund_rest", "refunded_full"],
  ["captured", "refund_over", "exceeds_refundable"],
  ["refunded_partial", "refund_part", "refunded_partial"],
  ["refunded_partial", "refund_rest", "refunded_full"],
  ["refunded_partial", "refund_over", "exceeds_refundable"],
  ["captured", "release", "not_held"],
  ["refunded_partial", "release", "not_held"],
  // 扣减的键是 capture:point_hold:{id}：已扣减过的再扣是重放
  ["captured", "capture", "replay"],
  ["refunded_partial", "capture", "replay"],
  // 第 5 行：released / refunded_full 任何事件都不变；键相同返回原结果
  ["released", "capture", "not_held"],
  ["released", "release", "replay"],
  ["released", "refund_part", "not_captured"],
  ["refunded_full", "capture", "replay"],
  ["refunded_full", "release", "not_held"],
  ["refunded_full", "refund_part", "exceeds_refundable"],
];

describe("冻结单状态表（验收 6；07 分组 第 2.13 节）", () => {
  it(
    "第 1 行：（新建）--hold--> held；其余各行逐行：新状态、重放、被拒的原因，被拒与重放都不落一行",
    async () => {
      h.clock.set(at("2026-01-05T12:00:00"));
      const who = await subscribed();
      const dramaId = await dramaPriced(100);
      await topUp(h, { entityId: who.entityId, points: 50_000 });

      /** 造一张处在指定状态的冻结单（应扣 90；部分退回 = 已退 30） */
      const holdIn = async (status: Status): Promise<string> => {
        const { pointHoldId } = await holdDrama(h, { ...who, dramaId });
        expect(await statusOf(pointHoldId)).toBe("held");
        if (status === "released") await releaseHold(h, pointHoldId);
        if (status !== "held" && status !== "released") await captureHold(h, pointHoldId);
        if (status === "refunded_partial") await refundHold(h, { pointHoldId, qty: 30 });
        if (status === "refunded_full") await refundHold(h, { pointHoldId, qty: 90 });
        expect(await statusOf(pointHoldId)).toBe(status);
        return pointHoldId;
      };
      const fire = (event: Event, pointHoldId: string, refundable: number) => {
        if (event === "capture") return captureHold(h, pointHoldId);
        if (event === "release") return releaseHold(h, pointHoldId);
        const qty =
          event === "refund_part" ? 20 : event === "refund_rest" ? refundable : refundable + 1;
        return refundHold(h, { pointHoldId, qty });
      };

      for (const [from, event, expected] of TRANSITIONS) {
        const label = `${from} --${event}--> ${expected}`;
        const pointHoldId = await holdIn(from);
        const refundable = from === "captured" ? 90 : from === "refunded_partial" ? 60 : 0;
        const before = await snapshotTables(prisma, TABLES);
        const outcome = await fire(event, pointHoldId, refundable).catch((error: unknown) => error);
        if (expected === "replay") {
          expect(outcome, label).toMatchObject({ replayed: true });
          assertSnapshotsEqual(before, await snapshotTables(prisma, TABLES));
        } else if (outcome instanceof HoldStateError) {
          expect(outcome.reason, label).toBe(expected);
          expect(outcome, label).toMatchObject({ pointHoldId, status: from });
          expect(outcome.refundableQty, label).toBe(refundable);
          assertSnapshotsEqual(before, await snapshotTables(prisma, TABLES));
        } else {
          expect(outcome, label).toMatchObject({ replayed: false });
          expect(await statusOf(pointHoldId), label).toBe(expected);
        }
      }
    },
    SLOW,
  );
});

describe("退回的去向（验收 6）", () => {
  it(
    "从分摊序列的尾部取：先退加购、再退套餐；原批次仍有效则原路退回。同一个键再退是重放，换了数量被拒",
    async () => {
      h.clock.set(at("2026-03-05T12:00:00"));
      const who = await subscribed();
      await topUp(h, { entityId: who.entityId, points: 1000 });
      await adjustPoints(h, { ...who, direction: "decrease", lotKind: "plan", points: 4680 });
      // 应扣 2,160：套餐 1,920（序号 1）、加购 240（序号 2）
      const { pointHoldId } = await holdDrama(h, { ...who, dramaId: await dramaPriced(2400) });
      await captureHold(h, pointHoldId);

      const line = uuidv7();
      const first = await refundHold(h, { pointHoldId, qty: 300, cancelRequestLineId: line });
      expect(first).toMatchObject({
        returnedPoints: 300,
        convertedPoints: 0,
        forfeitedPoints: 0,
        replayed: false,
      });
      let state = await dumpLedger(prisma, who.entityId);
      expect(state.holds[0]).toMatchObject({
        status: "refunded_partial",
        returnedQty: 300,
        forfeitedQty: 0,
        closedAt: null,
        allocs: [
          { allocNo: 1, lotKind: "plan", qty: 1920, returnedQty: 60 },
          { allocNo: 2, lotKind: "addon", qty: 240, returnedQty: 240 },
        ],
      });
      expect(state.account).toMatchObject({ planAvailableQty: 60, addonAvailableQty: 1000 });
      expect(state.operations.at(-1)).toMatchObject({
        opType: "refund",
        refType: "cancel_request_line",
        planDeltaQty: 60,
        addonDeltaQty: 240,
        spendableAfterQty: 1060,
        titleCode: "refund",
      });
      expect(state.entries.slice(-2)).toMatchObject([
        { lotKind: "addon", fromBucket: "consumed", toBucket: "available", qty: 240 },
        { lotKind: "plan", fromBucket: "consumed", toBucket: "available", qty: 60 },
      ]);
      expect(
        await prisma.outboxEvent.findFirstOrThrow({
          where: { entityId: who.entityId, eventType: "billing.points.returned" },
        }),
      ).toMatchObject({
        dedupeKey: `ledger:refund:${line}`,
        payload: { pointHoldId, returnedPoints: 300, convertedPoints: 0, forfeitedPoints: 0 },
      });

      // 同一条取消明细再退：重放；换了数量：拒绝
      const before = await snapshotTables(prisma, TABLES);
      expect(await refundHold(h, { pointHoldId, qty: 300, cancelRequestLineId: line })).toEqual({
        ...first,
        replayed: true,
      });
      const conflict = await refundHold(h, {
        pointHoldId,
        qty: 301,
        cancelRequestLineId: line,
      }).catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(LedgerError);
      expect(conflict).toMatchObject({ reason: "op_key_conflict" });
      assertSnapshotsEqual(before, await snapshotTables(prisma, TABLES));

      // 退完剩下的 1,860：全部回到套餐批次，冻结单关闭
      await refundHold(h, { pointHoldId, qty: 1860 });
      state = await dumpLedger(prisma, who.entityId);
      expect(state.holds[0]).toMatchObject({
        status: "refunded_full",
        returnedQty: 2160,
        closedAt: h.clock.now().toISOString(),
      });
      expect(state.account).toMatchObject({ planAvailableQty: 1920, addonAvailableQty: 1000 });
    },
    SLOW,
  );

  it(
    "原周期已结束、去向是 addon：套餐积分转为加购积分——原批次记转出，新建加购批次指回那条转出流水；加购部分原路退回",
    async () => {
      h.clock.set(at("2026-05-05T12:00:00"));
      const who = await subscribed();
      await topUp(h, { entityId: who.entityId, points: 1000 });
      await adjustPoints(h, { ...who, direction: "decrease", lotKind: "plan", points: 4680 });
      const dramaId = await dramaPriced(2400);
      // 冻结两张：一张扣减后在周期结束之后退回，一张一直冻结着、周期结束之后释放
      const captured = await holdDrama(h, { ...who, dramaId });
      await topUp(h, { entityId: who.entityId, points: 3000 });
      await adjustPoints(h, { ...who, direction: "increase", lotKind: "plan", points: 500 });
      const frozen = await holdDrama(h, { ...who, dramaId });
      await captureHold(h, captured.pointHoldId);
      // 续了费：上一期结束，新一期生效。上一期冻结的订购再取消，仍属“原周期已结束”，不并入新一期的套餐积分
      await openTerm(h, { entityId: who.entityId, after: who.term });
      h.clock.set(at("2026-06-06T10:00:00"));

      const refunded = await refundHold(h, {
        pointHoldId: captured.pointHoldId,
        qty: 2160,
        reasonClass: "platform",
      });
      expect(refunded).toMatchObject({
        returnedPoints: 240,
        convertedPoints: 1920,
        forfeitedPoints: 0,
      });
      const operation = await prisma.ledgerOperation.findUniqueOrThrow({
        where: { id: refunded.operationId },
      });
      expect(operation).toMatchObject({
        opType: "refund",
        planDeltaQty: 0,
        addonDeltaQty: 2160,
        titleArgs: { refNo: "LYX-TEST", reasonClass: "platform", isConversion: true },
      });
      const lot = await prisma.pointLot.findFirstOrThrow({
        where: { sourceType: "conversion", sourceId: refunded.operationId },
      });
      const out = await prisma.pointLedgerEntry.findUniqueOrThrow({
        where: { id: lot.originPointLedgerEntryId as string },
      });
      expect(lot).toMatchObject({
        kind: "addon",
        sourceNo: 1,
        originalQty: 1920,
        availableQty: 1920,
        costBasisFen: null,
        expiresAt: null,
        subscriptionTermId: null,
        originPointLotId: out.pointLotId,
      });
      expect(out).toMatchObject({
        ledgerOperationId: refunded.operationId,
        pointHoldId: captured.pointHoldId,
        lotKind: "plan",
        fromBucket: "consumed",
        toBucket: "converted_out",
        qty: 1920,
      });
      expect(
        await prisma.pointLedgerEntry.findFirstOrThrow({ where: { pointLotId: lot.id } }),
      ).toMatchObject({ fromBucket: "external", toBucket: "available", qty: 1920 });

      // 开工前取消（释放）：来源桶是“冻结”。这张落在调整增加的套餐批次 500 与两个加购批次 760、900 上
      expect(frozen.allocations.map(({ lotKind, qty }) => [lotKind, qty])).toEqual([
        ["plan", 500],
        ["addon", 760],
        ["addon", 900],
      ]);
      const released = await releaseHold(h, frozen.pointHoldId);
      expect(released).toMatchObject({ returnedPoints: 1660, convertedPoints: 500 });
      const state = await dumpLedger(prisma, who.entityId);
      expect(state.entries.slice(-4)).toMatchObject([
        { lotKind: "addon", fromBucket: "held", toBucket: "available", qty: 900 },
        { lotKind: "addon", fromBucket: "held", toBucket: "available", qty: 760 },
        { lotKind: "plan", fromBucket: "held", toBucket: "converted_out", qty: 500 },
        { lotKind: "addon", fromBucket: "external", toBucket: "available", qty: 500 },
      ]);
      expect(state.holds.map((hold) => [hold.status, hold.returnedQty, hold.forfeitedQty])).toEqual(
        [
          ["refunded_full", 2160, 0],
          ["released", 2160, 0],
        ],
      );
      // 新一期的套餐积分没有因为退回而变多：6,600；加购 = 1,000 + 3,000 + 转入的 1,920 + 500
      expect(state.account).toMatchObject({
        subStatus: "active",
        planAvailableQty: 6600,
        addonAvailableQty: 6420,
        heldTotalQty: 0,
      });
      expect(state.lotBuckets.reduce((sum, lot) => sum + lot.convertedOutQty, 0)).toBe(2420);
    },
    SLOW,
  );

  it(
    "去向是 forfeit：原周期已结束的套餐积分不予退回，记清零；读的是下单时的快照，不是当前参数",
    async () => {
      // 2027-01-01 起，商家原因取 forfeit（平台原因仍转加购）；2027-03-01 起又改回 addon
      const rule = (merchant: "addon" | "forfeit", effectiveAt: Date) => ({
        id: uuidv7(),
        key: "expiredTermRefund",
        value: { merchant, platform: "addon", qualification: "addon" },
        effectiveAt,
        changeId: uuidv7(),
        createdAt: h.clock.now(),
      });
      await prisma.billingParam.createMany({
        data: [
          rule("forfeit", at("2027-01-01T00:00:00")),
          rule("addon", at("2027-03-01T00:00:00")),
        ],
      });
      h.clock.set(at("2027-01-10T12:00:00"));
      const who = await subscribed();
      await topUp(h, { entityId: who.entityId, points: 1000 });
      await adjustPoints(h, { ...who, direction: "decrease", lotKind: "plan", points: 4680 });
      const dramaId = await dramaPriced(2400);
      const [mine, theirs] = [
        await holdDrama(h, { ...who, dramaId }),
        await holdDrama(h, { ...who, dramaId: await dramaPriced(100) }),
      ];
      expect(mine.snapshot.expiredTermRefund).toMatchObject({ merchant: "forfeit" });
      await captureHold(h, mine.pointHoldId);

      // 周期结束之后才取消，那时参数已改回 addon：仍按快照
      h.clock.set(at("2027-03-10T12:00:00"));
      const refunded = await refundHold(h, { pointHoldId: mine.pointHoldId, qty: 2160 });
      // 套餐部分 1,920 不予退回；加购部分 240 原路退回（套餐过期，处于停用）
      expect(refunded).toMatchObject({
        returnedPoints: 240,
        convertedPoints: 0,
        forfeitedPoints: 1920,
      });
      let state = await dumpLedger(prisma, who.entityId);
      expect(state.holds[0]).toMatchObject({
        status: "refunded_full",
        returnedQty: 240,
        forfeitedQty: 1920,
        allocs: [
          { lotKind: "plan", qty: 1920, returnedQty: 0, forfeitedQty: 1920 },
          { lotKind: "addon", qty: 240, returnedQty: 240, forfeitedQty: 0 },
        ],
      });
      expect(state.entries.slice(-2)).toMatchObject([
        { lotKind: "addon", fromBucket: "consumed", toBucket: "available", qty: 240 },
        { lotKind: "plan", fromBucket: "consumed", toBucket: "expired", qty: 1920 },
      ]);
      expect(state.operations.at(-1)).toMatchObject({
        opType: "refund",
        planDeltaQty: 0,
        addonDeltaQty: 240,
        spendableAfterQty: 0,
      });
      expect(
        await prisma.pointLot.count({
          where: { entityId: who.entityId, sourceType: "conversion" },
        }),
      ).toBe(0);

      // 同一期的另一张（落在加购批次上，没扣减）：平台原因释放，加购批次原路退回
      const released = await releaseHold(h, theirs.pointHoldId, "platform");
      expect(released).toMatchObject({
        returnedPoints: 90,
        convertedPoints: 0,
        forfeitedPoints: 0,
      });
      state = await dumpLedger(prisma, who.entityId);
      expect(state.account).toMatchObject({
        subStatus: "expired",
        planAvailableQty: 0,
        addonAvailableQty: 1000,
        heldTotalQty: 0,
      });
    },
    SLOW,
  );
});
