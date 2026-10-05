import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createLedgerHarness,
  dumpLedger,
  openTerm,
  ownerContext,
  topUp,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness } from "../../testing/index.js";

// 验收 7：advance。到点发放、清零（冻结不动）、预约周期接续并发首月、过期后写 addon_suspend；
// 先清零后发放；停 60 天后一次追赶的结果与逐日推进相同。
// 时钟起点是 2026-01-05 12:00（北京时间）：月付的一期是 01-05 至 02-04，止点 02-05 00:00。

const SLOW = 120_000;
const DAY = 86_400_000;
const at = (local: string): Date => new Date(`${local}+08:00`);

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: LedgerHarness;

beforeAll(async () => {
  prisma = await db.prisma();
  h = createLedgerHarness(prisma);
}, SLOW);

const advance = (entityId: string) => h.tx.run((tx) => h.ledger.advance(tx, entityId));
const outbox = async (entityId: string) =>
  (await prisma.outboxEvent.findMany({ where: { entityId }, orderBy: { seq: "asc" } })).map(
    (event) => ({ type: event.eventType, dedupeKey: event.dedupeKey, payload: event.payload }),
  );

describe("advance：到点的事只在这里发生（验收 7）", () => {
  it(
    "开通：首月当场发放，批次到期 = 周期止点、成本 = 该月分摊的套餐款；账户记下一个要处理的时刻",
    async () => {
      h.clock.set(at("2026-01-05T12:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      const { term, schedules } = await openTerm(h, { entityId: entity.id });

      const state = await dumpLedger(prisma, entity.id);
      expect(state.account).toMatchObject({
        subStatus: "active",
        currentTermNo: 1,
        planAvailableQty: 6600,
        addonAvailableQty: 0,
        nextDueAt: "2026-02-04T16:00:00.000Z",
      });
      expect(state.lots).toEqual([
        {
          kind: "plan",
          sourceType: "grant_monthly",
          termNo: 1,
          grantedAt: "2026-01-05T04:00:00.000Z",
          bizDate: "2026-01-05",
          expiresAt: "2026-02-04T16:00:00.000Z",
          originalQty: 6600,
          availableQty: 6600,
          heldQty: 0,
          expiredQty: 0,
          costBasisFen: 600_000,
        },
      ]);
      expect(state.schedules).toEqual([
        {
          termNo: 1,
          monthNo: 0,
          status: "granted",
          points: 6600,
          grantedAt: "2026-01-05T04:00:00.000Z",
        },
      ]);
      expect(state.operations).toEqual([
        {
          opType: "grant",
          refType: "grant_schedule",
          occurredAt: "2026-01-05T04:00:00.000Z",
          bizDate: "2026-01-05",
          planDeltaQty: 6600,
          addonDeltaQty: 0,
          spendableAfterQty: 6600,
          heldAfterQty: 0,
          titleCode: "grant_open",
          actorType: "system",
        },
      ]);
      expect(state.entries).toMatchObject([
        { fromBucket: "external", toBucket: "available", qty: 6600, lotKind: "plan" },
      ]);
      const operation = await prisma.ledgerOperation.findFirstOrThrow({
        where: { entityId: entity.id },
      });
      expect(operation.opKey).toBe(`grant:grant_schedule:${schedules[0]?.id}`);
      expect(operation.titleArgs).toMatchObject({
        planName: "专业版",
        termStartDate: "2026-01-05",
        termEndDate: "2026-02-04",
      });
      expect(await outbox(entity.id)).toEqual([
        {
          type: "billing.points.granted",
          dedupeKey: `billing.points.granted:${schedules[0]?.id}`,
          payload: {
            v: 1,
            entityId: entity.id,
            termId: term.id,
            grantScheduleId: schedules[0]?.id,
            points: 6600,
            monthIndex: 0,
          },
        },
      ]);

      // 幂等：没到点再推进，什么都不做
      expect(await advance(entity.id)).toEqual({
        granted: 0,
        expired: 0,
        rolledOver: 0,
        suspended: false,
      });
      expect(await dumpLedger(prisma, entity.id)).toEqual(state);
    },
    SLOW,
  );

  it(
    "季付：到当月发放日发放，逻辑时间是发放日 00:00，文案是“本月套餐积分”；发过的不再发",
    async () => {
      h.clock.set(at("2026-01-05T12:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      await openTerm(h, { entityId: entity.id, months: 3 });
      expect((await dumpLedger(prisma, entity.id)).account.nextDueAt).toBe(
        "2026-02-04T16:00:00.000Z",
      );

      h.clock.set(at("2026-02-04T23:59:59"));
      expect((await advance(entity.id))?.granted).toBe(0);
      h.clock.set(at("2026-02-05T09:30:00"));
      expect((await advance(entity.id))?.granted).toBe(1);
      expect((await advance(entity.id))?.granted).toBe(0);

      const state = await dumpLedger(prisma, entity.id);
      expect(state.account).toMatchObject({
        planAvailableQty: 13_200,
        nextDueAt: "2026-03-04T16:00:00.000Z",
      });
      expect(state.operations.at(-1)).toMatchObject({
        opType: "grant",
        occurredAt: "2026-02-04T16:00:00.000Z",
        bizDate: "2026-02-05",
        planDeltaQty: 6600,
        spendableAfterQty: 13_200,
        titleCode: "grant_monthly",
      });
      // 每个月的成本：周期实付 ÷ 3
      expect(state.lots.map((lot) => lot.costBasisFen)).toEqual([600_000, 600_000]);
      expect(state.lots.every((lot) => lot.expiresAt === "2026-04-04T16:00:00.000Z")).toBe(true);
    },
    SLOW,
  );

  it(
    "到期且没有预约周期：清零只动可用、冻结留在原批次；订阅过期，写 addon_suspend，加购积分停用",
    async () => {
      h.clock.set(at("2026-01-05T12:00:00"));
      const { entity, store, user } = await h.make.merchant({ verified: true });
      const { term } = await openTerm(h, { entityId: entity.id });
      await topUp(h, { entityId: entity.id, points: 1000, ctx: ownerContext(entity.id, user.id) });
      // 冻结一族还没有：直接在批次与账户上摆出“冻结 500”，配一张冻结中的冻结单
      const lot = await prisma.pointLot.findFirstOrThrow({
        where: { entityId: entity.id, kind: "plan" },
      });
      await h.make.pointHold({
        entityId: entity.id,
        storeId: store.id,
        subscriptionTermId: term.id,
        qty: 500,
      });
      await prisma.pointLot.update({
        where: { id: lot.id },
        data: { availableQty: { decrement: 500 }, heldQty: { increment: 500 } },
      });
      await prisma.billingAccount.update({
        where: { entityId: entity.id },
        data: { planAvailableQty: { decrement: 500 }, heldTotalQty: { increment: 500 } },
      });

      h.clock.set(at("2026-02-05T00:00:30"));
      expect(await advance(entity.id)).toEqual({
        granted: 0,
        expired: 1,
        rolledOver: 0,
        suspended: true,
      });

      const state = await dumpLedger(prisma, entity.id);
      expect(state.account).toEqual({
        subStatus: "expired",
        currentTermNo: null,
        planAvailableQty: 0,
        addonAvailableQty: 1000,
        heldTotalQty: 500,
        nextDueAt: null,
        lastExpiredQty: 6100,
        lastExpiredAt: "2026-02-04T16:00:00.000Z",
      });
      expect(state.lots.find((row) => row.kind === "plan")).toMatchObject({
        availableQty: 0,
        heldQty: 500,
        expiredQty: 6100,
      });
      expect(state.terms).toMatchObject([{ status: "ended", endedAt: "2026-02-04T16:00:00.000Z" }]);
      // 清零的逻辑时间是止点，业务日是周期最后一天；紧接着停用，闸门关上、可花为 0
      expect(state.operations.slice(-2)).toEqual([
        {
          opType: "expire",
          refType: "subscription_term",
          occurredAt: "2026-02-04T16:00:00.000Z",
          bizDate: "2026-02-04",
          planDeltaQty: -6100,
          addonDeltaQty: 0,
          spendableAfterQty: 0,
          heldAfterQty: 500,
          titleCode: "term_expire",
          actorType: "system",
        },
        {
          opType: "addon_suspend",
          refType: "subscription_term",
          occurredAt: "2026-02-04T16:00:00.000Z",
          bizDate: "2026-02-04",
          planDeltaQty: 0,
          addonDeltaQty: 0,
          spendableAfterQty: 0,
          heldAfterQty: 500,
          titleCode: "addon_suspend",
          actorType: "system",
        },
      ]);
      expect(state.entries.at(-1)).toEqual({
        lotKind: "plan",
        fromBucket: "available",
        toBucket: "expired",
        qty: 6100,
        occurredAt: "2026-02-04T16:00:00.000Z",
        bizDate: "2026-02-04",
      });
      expect(state.subscriptionEvents).toEqual([
        {
          type: "expired",
          termNo: 1,
          occurredAt: "2026-02-04T16:00:00.000Z",
          bizDate: "2026-02-04",
        },
      ]);
      const keys = await prisma.ledgerOperation.findMany({
        where: { entityId: entity.id, opType: { in: ["expire", "addon_suspend"] } },
        orderBy: { seq: "asc" },
        select: { opKey: true },
      });
      expect(keys.map((row) => row.opKey)).toEqual([
        `expire:subscription_term:${term.id}:2026-02-04`,
        `suspend:subscription_term:${term.id}:2026-02-04`,
      ]);
      expect((await outbox(entity.id)).slice(-2)).toEqual([
        {
          type: "billing.points.expired",
          dedupeKey: `billing.points.expired:${term.id}`,
          payload: { v: 1, entityId: entity.id, termId: term.id, expiredPoints: 6100 },
        },
        {
          type: "billing.subscription.expired",
          dedupeKey: `ledger:suspend:subscription_term:${term.id}:2026-02-04`,
          payload: {
            v: 1,
            termId: term.id,
            entityId: entity.id,
            endedAt: "2026-02-04T16:00:00.000Z",
          },
        },
      ]);

      // 过期之后加购照常入账，处于停用：可花仍是 0
      await topUp(h, { entityId: entity.id, points: 3000 });
      expect((await dumpLedger(prisma, entity.id)).operations.at(-1)).toMatchObject({
        opType: "purchase",
        addonDeltaQty: 3000,
        spendableAfterQty: 0,
      });
    },
    SLOW,
  );

  it(
    "有预约周期：同一事务先清零、再接续、再发首月；流水的先后与业务日照原型（09-12 24:00 清零，09-13 00:00 发放）",
    async () => {
      h.clock.set(at("2026-01-05T12:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      const first = await openTerm(h, { entityId: entity.id });
      const second = await openTerm(h, {
        entityId: entity.id,
        after: first.term,
        planCode: "flagship",
      });
      expect(second.term).toMatchObject({ status: "scheduled", termNo: 2 });

      h.clock.set(at("2026-02-05T08:00:00"));
      expect(await advance(entity.id)).toEqual({
        granted: 1,
        expired: 1,
        rolledOver: 1,
        suspended: false,
      });

      const state = await dumpLedger(prisma, entity.id);
      expect(state.account).toMatchObject({
        subStatus: "active",
        currentTermNo: 2,
        planAvailableQty: 14_400,
        lastExpiredQty: 6600,
        nextDueAt: "2026-03-04T16:00:00.000Z",
      });
      expect(state.terms).toMatchObject([
        { termNo: 1, status: "ended" },
        { termNo: 2, status: "active", activatedAt: "2026-02-04T16:00:00.000Z" },
      ]);
      expect(state.operations.slice(-2)).toMatchObject([
        // 有预约周期接着生效：清零之后闸门不关，可花 = 加购可用（这里是 0）
        { opType: "expire", bizDate: "2026-02-04", planDeltaQty: -6600, spendableAfterQty: 0 },
        {
          opType: "grant",
          bizDate: "2026-02-05",
          planDeltaQty: 14_400,
          spendableAfterQty: 14_400,
          titleCode: "grant_term",
        },
      ]);
      expect(state.operations.slice(-2).map((op) => op.occurredAt)).toEqual([
        "2026-02-04T16:00:00.000Z",
        "2026-02-04T16:00:00.000Z",
      ]);
      expect(state.subscriptionEvents).toEqual([
        {
          type: "rolled_over",
          termNo: 2,
          occurredAt: "2026-02-04T16:00:00.000Z",
          bizDate: "2026-02-05",
        },
      ]);
      const rolled = (await outbox(entity.id)).find(
        (event) => event.type === "billing.subscription.rolled_over",
      );
      expect(rolled?.payload).toEqual({
        v: 1,
        termId: second.term.id,
        prevTermId: first.term.id,
        entityId: entity.id,
      });
    },
    SLOW,
  );

  it(
    "停 60 天以上后一次追赶，与逐日推进的结果逐项相同：发放、清零、接续、再到期",
    async () => {
      // 季付 01-05 至 04-04，后面接一个月付的预约周期 04-05 至 05-04；03-01 起停摆，05-10 才恢复
      const prepare = async (): Promise<string> => {
        h.clock.set(at("2026-01-05T12:00:00"));
        const { entity } = await h.make.merchant({ verified: true });
        const first = await openTerm(h, { entityId: entity.id, months: 3 });
        await openTerm(h, { entityId: entity.id, after: first.term });
        h.clock.set(at("2026-03-01T10:00:00"));
        await advance(entity.id);
        return entity.id;
      };
      const stalled = await prepare();
      const daily = await prepare();

      for (
        let day = at("2026-03-02T10:00:00").getTime();
        day <= at("2026-05-10T10:00:00").getTime();
        day += DAY
      ) {
        h.clock.set(new Date(day));
        await advance(daily);
      }
      h.clock.set(at("2026-05-10T10:00:00"));
      expect(await advance(stalled)).toEqual({
        granted: 2,
        expired: 2,
        rolledOver: 1,
        suspended: true,
      });

      const caughtUp = await dumpLedger(prisma, stalled);
      expect(caughtUp).toEqual(await dumpLedger(prisma, daily));
      expect(caughtUp.operations.map((op) => [op.opType, op.bizDate])).toEqual([
        ["grant", "2026-01-05"],
        ["grant", "2026-02-05"],
        ["grant", "2026-03-05"],
        ["expire", "2026-04-04"],
        ["grant", "2026-04-05"],
        ["expire", "2026-05-04"],
        ["addon_suspend", "2026-05-04"],
      ]);
      expect(caughtUp.account).toMatchObject({ subStatus: "expired", planAvailableQty: 0 });
      expect(caughtUp.schedules.every((row) => row.status === "granted")).toBe(true);
    },
    SLOW,
  );
});
