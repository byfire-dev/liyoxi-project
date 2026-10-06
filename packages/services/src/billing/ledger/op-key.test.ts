import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import { uuidv7 } from "../../kernel/index.js";
import {
  adjustPoints,
  assertSnapshotsEqual,
  captureHold,
  createLedgerHarness,
  holdDrama,
  openTerm,
  priceDrama,
  refundHold,
  releaseHold,
  snapshotTables,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness, dramaHoldInput } from "../../testing/index.js";
import { LedgerError } from "./index.js";

// 验收 3（顺序的一半；并发的一半在 hold.concurrency.test.ts）：操作键重放。
// 同一个键再来一次返回第一次的结果，各表的快照与只调用一次相同；同一业务引用换了计价入参被拒。
// 发放与加购入账的重放在 account.test.ts。

const SLOW = 180_000;
const TABLES = [
  "billing_account",
  "subscription_term",
  "grant_schedule",
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
/** 调一次，记下各表；再调一次：结果除 replayed 外相同，各表与只调用一次相同 */
async function expectReplay<T extends { replayed: boolean }>(run: () => Promise<T>): Promise<T> {
  const first = await run();
  expect(first.replayed).toBe(false);
  const once = await snapshotTables(prisma, TABLES);
  expect(await run()).toEqual({ ...first, replayed: true });
  assertSnapshotsEqual(once, await snapshotTables(prisma, TABLES));
  return first;
}
const conflictOf = async (run: Promise<unknown>): Promise<unknown> => {
  const error = await run.catch((caught: unknown) => caught);
  return error instanceof LedgerError ? error.reason : error;
};

describe("操作键重放（验收 3）", () => {
  it(
    "冻结、扣减、释放、退回、调整：同一个键再来一次，返回第一次的结果，各表与只调用一次相同",
    async () => {
      h.clock.set(at("2026-01-05T12:00:00"));
      const who = await subscribed();
      const dramaId = await dramaPriced(1000);
      const [first, second] = [uuidv7(), uuidv7()];

      const held = await expectReplay(() => holdDrama(h, { ...who, dramaId, refId: first }));
      const toRelease = await expectReplay(() => holdDrama(h, { ...who, dramaId, refId: second }));
      await expectReplay(() => captureHold(h, held.pointHoldId));
      await expectReplay(() => releaseHold(h, toRelease.pointHoldId));
      const line = uuidv7();
      await expectReplay(() =>
        refundHold(h, { pointHoldId: held.pointHoldId, qty: 400, cancelRequestLineId: line }),
      );
      const requestNo = `TZ-${uuidv7()}`;
      const adjust = { ...who, direction: "increase", lotKind: "addon", points: 70 } as const;
      const once = await adjustPoints(h, { ...adjust, requestNo });
      const snapshot = await snapshotTables(prisma, TABLES);
      // 调整的夹具每次现生成审批单 id：同一个审批单号、换了审批单，按冲突拒绝
      expect(await conflictOf(adjustPoints(h, { ...adjust, requestNo }))).toBe("op_key_conflict");
      assertSnapshotsEqual(snapshot, await snapshotTables(prisma, TABLES));
      expect(once).toMatchObject({ deltaPoints: 70, replayed: false });

      // 冻结的重放不再过守卫，也不重新计价：冻结单已经扣减、退回过，套餐也过期了，同一个引用再来仍返回当初那一张
      h.clock.set(at("2026-03-01T12:00:00"));
      await priceDrama(h, { dramaId, points: 5000, staffId });
      await h.tx.run((tx) => h.ledger.advance(tx, who.entityId));
      const late = await holdDrama(h, { ...who, dramaId, refId: first });
      expect(late).toMatchObject({
        pointHoldId: held.pointHoldId,
        operationId: held.operationId,
        points: 900,
        snapshot: held.snapshot,
        allocations: held.allocations,
        replayed: true,
      });
    },
    SLOW,
  );

  it(
    "同一业务引用换了计价入参被拒：换剧、换是否选用顶级模型、换门店、换主体；什么都不写",
    async () => {
      h.clock.set(at("2026-04-05T12:00:00"));
      const who = await subscribed();
      const stranger = await subscribed();
      const [dramaId, another] = [await dramaPriced(1000), await dramaPriced(1000)];
      const refId = uuidv7();
      await holdDrama(h, { ...who, dramaId, refId });
      const secondStore = await h.make.store({ entityId: who.entityId });
      const before = await snapshotTables(prisma, TABLES);

      const again = (change: Partial<Parameters<typeof dramaHoldInput>[0]>) =>
        conflictOf(holdDrama(h, { ...who, dramaId, refId, ...change }));
      expect(await again({ dramaId: another })).toBe("op_key_conflict");
      expect(await again({ topModel: true })).toBe("op_key_conflict");
      expect(await again({ storeId: secondStore.id })).toBe("op_key_conflict");
      expect(await again({ entityId: stranger.entityId, storeId: stranger.storeId })).toBe(
        "op_key_conflict",
      );
      // 期望值不参与比对：重放返回的是当初的应扣
      expect(await holdDrama(h, { ...who, dramaId, refId, expectS: 1 })).toMatchObject({
        points: 900,
        replayed: true,
      });
      assertSnapshotsEqual(before, await snapshotTables(prisma, TABLES));
    },
    SLOW,
  );
});
