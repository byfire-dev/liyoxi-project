import { beforeEach, expect, it } from "vitest";
import { createConfig } from "../../config/index.js";
import { createTenant } from "../../tenant/index.js";
import { createIdentityContext } from "../../kernel/index.js";
import {
  assembleForTest,
  createPaymentHarness,
  sampleStaffContext,
  useSeededDatabase,
  snapshotTables,
  pendingPlanOrder,
  transferReceipt,
  applyReceipt,
} from "../../testing/index.js";
import { createPointPacks } from "./point-packs.js";
const db = useSeededDatabase("services", { max: 1 });
beforeEach(() => db.reset(), 60000);
async function setup(at = "2026-10-01T00:00:00.000Z") {
  const prisma = await db.prisma(),
    h = createPaymentHarness(prisma);
  h.clock.set(new Date(at));
  const assembly = assembleForTest({ entry: "api" });
  const packs = createPointPacks({
    tx: h.tx,
    clock: h.clock,
    tenant: createTenant({ tx: h.tx, clock: h.clock, flow: h.paymentDeps.flow, assembly }),
    config: createConfig({ db: prisma, clock: h.clock, redis: null }),
  });
  const staff = await h.make.staff({ staffRoleKey: "super_admin" });
  const actor = {
    identity: createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
    staff: await sampleStaffContext(prisma, staff.id),
  };
  return { ...h, packs, actor };
}
it("档位按真实版本与上架唯一性修改，边界/冲突零写且稳定排序只读", async () => {
  const h = await setup(),
    t = ["point_pack", "audit_log"];
  const empty = await snapshotTables(h.prisma, t);
  for (const bad of [
    { points: 99, priceFen: 1 },
    { points: 100, priceFen: 0 },
    { points: 1.5, priceFen: 1 },
    { points: 100, priceFen: 1, position: -2147483649 },
  ])
    expect(() => h.packs.create(h.actor, bad)).toThrow(
      expect.objectContaining({ error: "VALIDATION_FAILED" }),
    );
  expect(await snapshotTables(h.prisma, t)).toEqual(empty);
  const first = await h.packs.create(h.actor, { points: 617, priceFen: 39901 });
  const second = await h.packs.create(h.actor, { points: 900, priceFen: 80001 });
  expect(first).toMatchObject({ isListed: true, points: 617, priceFen: 39901, lockVersion: 0 });
  expect(second.position).toBe(first.position + 1);
  await expect(h.packs.create(h.actor, { points: 617, priceFen: 1 })).rejects.toMatchObject({
    error: "POINT_PACK_DUPLICATE",
  });
  const before = await snapshotTables(h.prisma, t);
  await expect(
    h.packs.update(h.actor, first.pointPackId, { lockVersion: 1, priceFen: 1 }),
  ).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
  await expect(
    h.packs.update(h.actor, first.pointPackId, { lockVersion: 0, points: 900 }),
  ).rejects.toMatchObject({ error: "POINT_PACK_DUPLICATE" });
  expect(await snapshotTables(h.prisma, t)).toEqual(before);
  const changed = await h.packs.update(h.actor, first.pointPackId, {
    lockVersion: 0,
    priceFen: 35001,
    position: second.position,
  });
  expect(changed).toMatchObject({ lockVersion: 1, priceFen: 35001 });
  await h.packs.delist(h.actor, first.pointPackId);
  const replacement = await h.packs.create(h.actor, { points: 617, priceFen: 42001 });
  await expect(h.packs.shelve(h.actor, first.pointPackId)).rejects.toMatchObject({
    error: "POINT_PACK_DUPLICATE",
  });
  await expect(h.packs.delist(h.actor, first.pointPackId)).rejects.toMatchObject({
    error: "STATE_NOT_ALLOWED",
  });
  const frozen = await snapshotTables(h.prisma, t);
  const all = await h.packs.listAdmin(h.actor.staff, {}),
    listed = await h.packs.listAdmin(h.actor.staff, { isListed: true });
  const ownIds = [first.pointPackId, second.pointPackId, replacement.pointPackId];
  expect(all.items.filter((p) => ownIds.includes(p.pointPackId)).map((p) => p.pointPackId)).toEqual(
    ownIds,
  );
  expect(
    listed.items.filter((p) => ownIds.includes(p.pointPackId)).map((p) => p.pointPackId),
  ).toEqual([second.pointPackId, replacement.pointPackId]);
  expect(listed.items.every((p) => p.isListed)).toBe(true);
  expect(await snapshotTables(h.prisma, t)).toEqual(frozen);
});
it("六个月KPI分别取真实收款与purchase流水，未付款排除、北京月份与零写一致", async () => {
  const h = await setup("2026-05-15T00:00:00.000Z");
  const pack = await h.packs.create(h.actor, { points: 617, priceFen: 39901 });
  async function paid(at: string, points: number, price: number) {
    h.clock.set(new Date(at));
    const own = await h.make.merchant({ verified: true });
    const plan = await pendingPlanOrder(h, { entityId: own.entity.id });
    await applyReceipt(h, await transferReceipt(h, plan));
    const order = await h.make.billingOrder({
      entityId: own.entity.id,
      storeId: own.store.id,
      type: "topup",
      status: "pending_payment",
      fulfillmentStatus: "none",
      fulfilledAt: null,
      channel: "bank_transfer",
      transferState: "awaiting_proof",
      bankAccountFinanceConfigRevisionId: plan.bankAccountFinanceConfigRevisionId,
      amountFen: price,
      contentSnapshot: { v: 1, kind: "topup", packId: pack.pointPackId, points, payFen: price },
    });
    expect((await applyReceipt(h, await transferReceipt(h, order))).result).toMatchObject({
      status: "applied",
      fulfillment: { status: "done" },
    });
    return { own, order };
  }
  await paid("2026-05-15T00:00:00.000Z", 111, 12345);
  const current = await paid("2026-09-30T16:00:00.000Z", 617, 39901);
  const another = await h.make.merchant({ verified: true });
  const plan = await pendingPlanOrder(h, { entityId: another.entity.id });
  await applyReceipt(h, await transferReceipt(h, plan));
  await h.make.billingOrder({
    entityId: current.own.entity.id,
    type: "topup",
    status: "pending_payment",
    fulfillmentStatus: "none",
    fulfilledAt: null,
    amountFen: 99999,
    contentSnapshot: { v: 1, kind: "topup", packId: pack.pointPackId, points: 999, payFen: 99999 },
  });
  const tables = [
      "billing_order",
      "point_pack",
      "point_lot",
      "point_ledger_entry",
      "ledger_operation",
      "audit_log",
    ],
    before = await snapshotTables(h.prisma, tables);
  const summary = await h.packs.summary(h.actor.staff);
  expect(summary).toMatchObject({
    month: "2026-10",
    topupCount: 1,
    topupFen: "39901",
    topupEntityCount: 1,
    topupRateBp: 5000,
  });
  expect(summary.monthly.map((m) => [m.month, m.points, m.isCurrent])).toEqual([
    ["2026-05", 111, false],
    ["2026-06", 0, false],
    ["2026-07", 0, false],
    ["2026-08", 0, false],
    ["2026-09", 0, false],
    ["2026-10", 617, true],
  ]);
  const row = (await h.packs.listAdmin(h.actor.staff, {})).items.find(
    (p) => p.pointPackId === pack.pointPackId,
  )!;
  expect(row).toMatchObject({ soldThisMonthCount: 1, soldThisMonthFen: "39901" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
});
