import { beforeAll, expect, it, vi } from "vitest";
import { createActor, createTxRunner, uuidv7 } from "../kernel/index.js";
import { createClock, createFactories, useSeededDatabase } from "../testing/index.js";
import { recordAssetUpload } from "./index.js";

const db = useSeededDatabase("services");
const clock = createClock(new Date("2026-10-10T04:00:00Z"));
let h: Awaited<ReturnType<typeof setup>>;
async function setup() {
  const prisma = await db.prisma();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const make = createFactories({ db: prisma, clock });
  const merchant = await make.merchant({ verified: true });
  const staff = await make.staff();
  return { prisma, tx, make, merchant, staff };
}
beforeAll(async () => {
  h = await setup();
}, 120_000);

function input(assetId = uuidv7()) {
  return {
    assetId,
    actor: createActor({
      type: "merchant",
      id: h.merchant.user.id,
      client: "weapp",
      role: "clerk",
    }),
    entityId: h.merchant.entity.id,
    storeId: h.merchant.store.id,
    type: "image",
    fileCount: 3,
    hasDemand: true,
    now: clock.now(),
  };
}
const eventId = (id: string) => `srv-${id}-asset_upload`;

it("素材提交同一事务直记真实 actor/scope/数量与需求，双连接重复只一条", async () => {
  const value = input();
  await Promise.all([
    h.tx.run((tx) => recordAssetUpload(tx, value)),
    h.tx.run((tx) => recordAssetUpload(tx, value)),
  ]);
  expect(await h.prisma.analyticsEvent.count({ where: { eventId: eventId(value.assetId) } })).toBe(
    1,
  );
  expect(
    await h.prisma.analyticsEvent.findFirstOrThrow({ where: { eventId: eventId(value.assetId) } }),
  ).toMatchObject({
    source: "direct",
    name: "asset_upload",
    occurredAt: clock.now(),
    receivedAt: clock.now(),
    actorType: "merchant",
    actorId: h.merchant.user.id,
    merchantUserId: h.merchant.user.id,
    client: "weapp",
    role: "clerk",
    entityId: h.merchant.entity.id,
    storeId: h.merchant.store.id,
    props: { type: "image", fileCount: 3, hasDemand: true, uploaderRole: "clerk" },
  });
  const staffValue = {
    ...input(),
    actor: createActor({ type: "staff", id: h.staff.id, client: "admin" }),
    type: "text",
    fileCount: 0,
    hasDemand: false,
  };
  await h.tx.run((tx) => recordAssetUpload(tx, staffValue));
  expect(
    await h.prisma.analyticsEvent.findFirstOrThrow({
      where: { eventId: eventId(staffValue.assetId) },
    }),
  ).toMatchObject({
    actorType: "staff",
    actorId: h.staff.id,
    merchantUserId: null,
    client: "admin",
    role: null,
    props: { type: "text", fileCount: 0, hasDemand: false, uploaderRole: "staff" },
  });
});

it("预留去重键和直记事件跟随调用方回滚，未提交事实只在同 Tx 可见", async () => {
  const value = input();
  await expect(
    h.tx.run(async (tx) => {
      await recordAssetUpload(tx, value);
      expect(await tx.analyticsEvent.count({ where: { eventId: eventId(value.assetId) } })).toBe(1);
      expect(
        await h.prisma.analyticsEvent.count({ where: { eventId: eventId(value.assetId) } }),
      ).toBe(0);
      throw new Error("asset outer rollback");
    }),
  ).rejects.toThrow("asset outer rollback");
  expect(
    await h.prisma.analyticsEventDedup.findUnique({ where: { eventId: eventId(value.assetId) } }),
  ).toBeNull();
  expect(await h.prisma.analyticsEvent.count({ where: { eventId: eventId(value.assetId) } })).toBe(
    0,
  );
  await h.tx.run((tx) => recordAssetUpload(tx, value));
  expect(await h.prisma.analyticsEvent.count({ where: { eventId: eventId(value.assetId) } })).toBe(
    1,
  );
});

it("真实分区拒绝只回滚埋点保存点，不吞外层失败且日志只有固定脱敏符号", async () => {
  const value = { ...input(), now: new Date("2099-01-01T00:00:00Z") };
  // 原 default 分区拒绝无分区月份；触发数据库错误，非 mock/客户端校验失败。
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await h.tx.run(async (tx) => {
      await tx.merchantUser.update({
        where: { id: h.merchant.user.id },
        data: { displayName: "保存点外提交" },
      });
      await recordAssetUpload(tx, value);
      expect(
        await tx.analyticsEventDedup.findUnique({ where: { eventId: eventId(value.assetId) } }),
      ).toBeNull();
      expect(
        await tx.merchantUser.findUniqueOrThrow({ where: { id: h.merchant.user.id } }),
      ).toMatchObject({ displayName: "保存点外提交" });
    });
    expect(
      await h.prisma.merchantUser.findUniqueOrThrow({ where: { id: h.merchant.user.id } }),
    ).toMatchObject({ displayName: "保存点外提交" });
    await expect(
      h.tx.run(async (tx) => {
        await tx.merchantUser.update({
          where: { id: h.merchant.user.id },
          data: { displayName: "应回滚" },
        });
        await recordAssetUpload(tx, { ...value, assetId: uuidv7() });
        throw new Error("original business failure");
      }),
    ).rejects.toThrow("original business failure");
    expect(
      await h.prisma.merchantUser.findUniqueOrThrow({ where: { id: h.merchant.user.id } }),
    ).toMatchObject({ displayName: "保存点外提交" });
    expect(log.mock.calls).toEqual([
      [{ evt: "analytics.asset_upload_failed" }, "素材直记埋点失败"],
      [{ evt: "analytics.asset_upload_failed" }, "素材直记埋点失败"],
    ]);
  } finally {
    log.mockRestore();
  }
});
