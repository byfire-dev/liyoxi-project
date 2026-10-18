import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, expect, it } from "vitest";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { createClock, createFactories, useSeededDatabase } from "../testing/index.js";
import { countBlockingStoreAds } from "./index.js";

const db = useSeededDatabase("services", { max: 1 });
const clock = createClock();
let prisma: PrismaClient;
let tx: ReturnType<typeof createTxRunner>;
beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
}, 120000);

const statuses = [
  "pending_assign",
  "producing",
  "returned",
  "pending_confirm",
  "revising",
  "confirmed",
  "cancelled",
] as const;
let sequence = 900;

// 仅构造已有表的计数事实；不声称交付 M5 广告提交、账本分摊或版本 producer。
async function seedAds(
  connection: PrismaClient | Tx,
  storeId: string,
  wanted: readonly (typeof statuses)[number][],
) {
  const make = createFactories({ db: connection, clock });
  const store = await connection.store.findUniqueOrThrow({
    where: { id: storeId },
    include: { entity: true },
  });
  const editor = await make.staff();
  const now = clock.now();
  for (const status of wanted) {
    const id = uuidv7();
    const captured = ["producing", "pending_confirm", "revising", "confirmed"].includes(status);
    const hold = await make.pointHold({
      entityId: store.entityId,
      storeId,
      purpose: "ad",
      refType: "ad",
      refId: id,
      status: captured ? "captured" : "held",
    });
    const consent = await make.agreementConsent({
      scene: "ad_request",
      merchantUserId: store.entity.createdByUserId,
      entityId: store.entityId,
      storeId,
      bizId: id,
    });
    await connection.ad.create({
      data: {
        id,
        adNo: `GG20260105${sequence++}`,
        entityId: store.entityId,
        storeId,
        requestedByUserId: store.entity.createdByUserId,
        type: "opening",
        durationSec: 3,
        promoPointCodes: ["TEST"],
        status,
        editorId: captured ? editor.id : null,
        capturedAt: captured ? now : null,
        returnedFrom: status === "returned" ? "pending_assign" : null,
        returnedAt: status === "returned" ? now : null,
        returnReason: status === "returned" ? "测试计数事实" : null,
        unitPricePoints: 100,
        discountBp: 10000,
        chargePoints: 100,
        pricingSnapshot: {},
        pointHoldId: hold.id,
        freeRevisionQuota: 2,
        latestVersionNo: status === "confirmed" || status === "pending_confirm" ? 1 : 0,
        confirmedVersionNo: status === "confirmed" ? 1 : null,
        confirmedAt: status === "confirmed" ? now : null,
        agreementConsentId: consent.id,
        submittedAt: now,
        firstDueAt: now,
        cancelledAt: status === "cancelled" ? now : null,
        cancelReasonCode: status === "cancelled" ? "merchant_request" : null,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
}

it("七种正式状态仅五种阻断，隔离同主体其他店及跨主体门店", async () => {
  const make = createFactories({ db: prisma, clock });
  const a = await make.merchant();
  const sibling = await make.store({ entityId: a.entity.id });
  const b = await make.merchant();
  const empty = await make.store();
  await seedAds(prisma, a.store.id, statuses);
  await seedAds(prisma, sibling.id, ["pending_assign"]);
  await seedAds(prisma, b.store.id, ["producing"]);
  await tx.run(async (t) => {
    expect(await countBlockingStoreAds(t, a.store.id)).toBe(5);
    expect(await countBlockingStoreAds(t, sibling.id)).toBe(1);
    expect(await countBlockingStoreAds(t, b.store.id)).toBe(1);
    expect(await countBlockingStoreAds(t, empty.id)).toBe(0);
    expect(await countBlockingStoreAds(t, uuidv7())).toBe(0);
  });
}, 60000);

it("重复读取保留广告、冻结、同意及审计历史出站事实", async () => {
  const make = createFactories({ db: prisma, clock });
  const a = await make.merchant();
  await seedAds(prisma, a.store.id, ["pending_confirm", "revising", "confirmed", "cancelled"]);
  const snapshot = async () => ({
    ads: await prisma.ad.findMany({ where: { storeId: a.store.id }, orderBy: { id: "asc" } }),
    holds: await prisma.pointHold.findMany({
      where: { storeId: a.store.id },
      orderBy: { id: "asc" },
    }),
    consents: await prisma.agreementConsent.findMany({
      where: { storeId: a.store.id },
      orderBy: { id: "asc" },
    }),
    versions: await prisma.adVersion.count(),
    revisions: await prisma.adRevision.count(),
    audit: await prisma.auditLog.count(),
    history: await prisma.statusTransition.count(),
    outbox: await prisma.outboxEvent.count(),
  });
  const before = await snapshot();
  for (let n = 0; n < 2; n++)
    await tx.run(async (t) => {
      expect(await countBlockingStoreAds(t, a.store.id)).toBe(2);
    });
  expect(await snapshot()).toEqual(before);
}, 60000);

it("只读调用方未提交的广告，外层失败完整回滚关联事实", async () => {
  const make = createFactories({ db: prisma, clock });
  const a = await make.merchant();
  await expect(
    tx.run(async (t) => {
      await seedAds(t, a.store.id, ["returned"]);
      expect(await countBlockingStoreAds(t, a.store.id)).toBe(1);
      throw new Error("测试调用方回滚");
    }),
  ).rejects.toThrow("测试调用方回滚");
  await tx.run(async (t) => {
    expect(await countBlockingStoreAds(t, a.store.id)).toBe(0);
  });
  expect(await prisma.ad.count({ where: { storeId: a.store.id } })).toBe(0);
  expect(await prisma.pointHold.count({ where: { storeId: a.store.id } })).toBe(0);
  expect(await prisma.agreementConsent.count({ where: { storeId: a.store.id } })).toBe(0);
}, 60000);
