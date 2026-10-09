import { beforeAll, expect, it } from "vitest";
import { createFlow } from "../flow/index.js";
import { uuidv7 } from "../kernel/index.js";
import { createTenant } from "../tenant/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { createOrderService } from "./service.js";
import { body, buyer, drama, harness, residual, version } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";

const db = useSeededDatabase("services", { max: 1 });
let h: Harness;
let tenant: ReturnType<typeof createTenant>;
beforeAll(async () => {
  h = harness(await db.prisma());
  tenant = createTenant({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    flow: createFlow({ assembly: h.assembly, clock: h.clock, events: h.events }),
  });
  await version(h);
}, 120000);
const empty = { orders: 0, items: 0, holds: 0, consents: 0 };
async function setLimit(entityId: string, storeLimitOverride: number | null) {
  await h.prisma.entity.update({ where: { id: entityId }, data: { storeLimitOverride } });
}

it("门店恰等上限允许，成员超额不阻断订剧，其他主体及已归档门店不占门店额度", async () => {
  const m = await h.make.merchant();
  await h.prisma.entity.update({
    where: { id: m.entity.id },
    data: { storeLimitOverride: 1, memberLimitOverride: 1 },
  });
  for (let i = 0; i < 2; i++) {
    const clerk = await h.make.entityMember({ entityId: m.entity.id });
    await h.make.storeMember({
      entityId: m.entity.id,
      entityMemberId: clerk.id,
      storeId: m.store.id,
      addedByMemberId: m.owner.id,
    });
  }
  await h.make.store();
  await h.make.store({
    entityId: m.entity.id,
    lifecycle: "archived",
    archivedAt: h.clock.now(),
    archiveActorType: "system",
    archiveReason: "by_owner",
  });
  await h.tx.run(async (tx) => {
    expect(await tenant.getQuotaUsage(tx, m.entity.id)).toMatchObject({
      storesUsed: 1,
      storeLimit: 1,
      storesOver: 0,
      seatsUsed: 2,
      seatsOver: 1,
    });
    await expect(tenant.assertWithinQuota(tx, m.entity.id)).resolves.toBeUndefined();
  });
});

it("实际生效套餐与覆盖值同源，清空覆盖恢复当前套餐且不会删原有门店", async () => {
  const b = await buyer(h);
  const planLimit = (await h.tx.run((tx) => tenant.getQuotaUsage(tx, b.entity.id))).storeLimit;
  expect(planLimit).toBeGreaterThan(1);
  await h.make.store({ entityId: b.entity.id });
  await setLimit(b.entity.id, 1);
  await expect(h.tx.run((tx) => tenant.assertWithinQuota(tx, b.entity.id))).rejects.toMatchObject({
    error: "QUOTA_EXCEEDED",
    details: { storesUsed: 2, storeLimit: 1, storesOver: 1 },
  });
  await setLimit(b.entity.id, null);
  await h.tx.run(async (tx) => {
    expect(await tenant.getQuotaUsage(tx, b.entity.id)).toMatchObject({
      storesUsed: 2,
      storeLimit: planLimit,
      limitReason: "plan",
    });
    await expect(tenant.assertWithinQuota(tx, b.entity.id)).resolves.toBeUndefined();
  });
  expect(
    await h.prisma.store.count({ where: { entityId: b.entity.id, lifecycle: "active" } }),
  ).toBe(2);
});

it("同一调用方事务可见未提交草稿门店，超额错误使新增门店原子回滚", async () => {
  const m = await h.make.merchant();
  await setLimit(m.entity.id, 1);
  const id = uuidv7();
  await expect(
    h.tx.run(async (tx) => {
      await tx.store.create({
        data: { id, entityId: m.entity.id, createdAt: h.clock.now(), updatedAt: h.clock.now() },
      });
      await tenant.assertWithinQuota(tx, m.entity.id);
    }),
  ).rejects.toMatchObject({
    error: "QUOTA_EXCEEDED",
    details: { storesUsed: 2, storeLimit: 1, storesOver: 1 },
  });
  expect(await h.prisma.store.findUnique({ where: { id } })).toBeNull();
  await expect(
    h.tx.run((tx) => tenant.assertWithinQuota(tx, m.entity.id)),
  ).resolves.toBeUndefined();
});

it("缺主体不是额度为零，原公开读侧NOT_FOUND直接传播", async () => {
  await expect(h.tx.run((tx) => tenant.assertWithinQuota(tx, uuidv7()))).rejects.toMatchObject({
    error: "NOT_FOUND",
  });
});

it("真实报价收集同一额度阻断且零写，真实订购在同意/冻结/单据之前拒绝", async () => {
  const b = await buyer(h),
    d = await drama(h),
    input = await body(h, b, [d.id]);
  await setLimit(b.entity.id, 1);
  await h.make.store({ entityId: b.entity.id });
  const before = await residual(h, b.entity.id);
  const quote = () =>
    h.order.quote(b.actor, {
      dramaIds: input.dramaIds,
      isTopModel: input.isTopModel,
      channelAccountIds: input.channelAccountIds,
    });
  for (let i = 0; i < 2; i++) {
    expect((await quote()).blockers.map((row) => row.code)).toEqual(["QUOTA_EXCEEDED"]);
    expect(await residual(h, b.entity.id)).toEqual(before);
  }
  await expect(h.order.create(b.actor, input)).rejects.toMatchObject({
    error: "QUOTA_EXCEEDED",
    details: { storesUsed: 2, storeLimit: 1, storesOver: 1 },
  });
  expect(await residual(h, b.entity.id)).toEqual(empty);
});

it("真实hold后额度变化仍在Tf复核，同意与冻结、覆盖值整笔回滚", async () => {
  const b = await buyer(h),
    d = await drama(h);
  await setLimit(b.entity.id, 2);
  await h.make.store({ entityId: b.entity.id });
  const input = await body(h, b, [d.id]),
    real = h.ledger.hold;
  const order = createOrderService({
    ...h.deps,
    ledger: {
      ...h.ledger,
      hold: async (tx, arg) => {
        const held = await real(tx, arg);
        await tx.entity.update({ where: { id: b.entity.id }, data: { storeLimitOverride: 1 } });
        return held;
      },
    },
  });
  await expect(order.create(b.actor, input)).rejects.toMatchObject({
    error: "QUOTA_EXCEEDED",
    details: { storesUsed: 2, storeLimit: 1, storesOver: 1 },
  });
  expect(await residual(h, b.entity.id)).toEqual(empty);
  expect(
    (await h.prisma.entity.findUniqueOrThrow({ where: { id: b.entity.id } })).storeLimitOverride,
  ).toBe(2);
});
