import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, expect, it } from "vitest";
import {
  createLedgerHarness,
  seedBillingDeletionFacts,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness } from "../../testing/index.js";
import { deletionGuard } from "../index.js";

const db = useSeededDatabase("services", { max: 1 });
let prisma: PrismaClient;
let h: LedgerHarness;
beforeAll(async () => {
  prisma = await db.prisma();
  h = createLedgerHarness(prisma);
}, 120000);
const empty = { subscription_active: 0, payment_open: 0, refund_open: 0, invoice_open: 0 };
const populated = { subscription_active: 2, payment_open: 4, refund_open: 1, invoice_open: 2 };

it("四类计数隔离主体，空主体真实为零，支付OR条件不重复计数", async () => {
  const a = await h.make.merchant();
  const b = await h.make.merchant();
  await h.tx.run((tx) =>
    seedBillingDeletionFacts(tx, h.clock, {
      entityId: b.entity.id,
      userId: b.user.id,
    }),
  );
  expect(await h.tx.run((tx) => deletionGuard(tx, a.entity.id))).toEqual(empty);
  expect(await h.tx.run((tx) => deletionGuard(tx, b.entity.id))).toEqual(populated);
  // 夹具的active/scheduled周期早已过止点，正式关闭口径仍按状态列计数。
  expect(h.clock.now().getUTCFullYear()).toBeGreaterThan(2024);
}, 60000);

it("反复读取不改变业务行、时间、状态历史、审计或出站事件", async () => {
  const { entity, user } = await h.make.merchant();
  await h.tx.run((tx) =>
    seedBillingDeletionFacts(tx, h.clock, {
      entityId: entity.id,
      userId: user.id,
    }),
  );
  const snapshot = async () => ({
    terms: await prisma.subscriptionTerm.findMany({
      where: { entityId: entity.id },
      orderBy: { id: "asc" },
    }),
    payments: await prisma.billingOrder.findMany({
      where: { entityId: entity.id },
      orderBy: { id: "asc" },
    }),
    refunds: await prisma.refundRequest.findMany({
      where: { entityId: entity.id },
      orderBy: { id: "asc" },
    }),
    invoices: await prisma.invoiceRequest.findMany({
      where: { entityId: entity.id },
      orderBy: { id: "asc" },
    }),
    history: await prisma.statusTransition.count(),
    audit: await prisma.auditLog.count(),
    outbox: await prisma.outboxEvent.count(),
  });
  const before = await snapshot();
  expect(await h.tx.run((tx) => deletionGuard(tx, entity.id))).toEqual(populated);
  expect(await h.tx.run((tx) => deletionGuard(tx, entity.id))).toEqual(populated);
  expect(await snapshot()).toEqual(before);
}, 60000);

it("读取调用方未提交的事实，外层失败时数据完整回滚", async () => {
  const { entity, user } = await h.make.merchant();
  const before = await prisma.billingOrder.count({ where: { entityId: entity.id } });
  await expect(
    h.tx.run(async (tx) => {
      await seedBillingDeletionFacts(tx, h.clock, { entityId: entity.id, userId: user.id });
      expect(await deletionGuard(tx, entity.id)).toEqual(populated);
      throw new Error("测试外层事务回滚");
    }),
  ).rejects.toThrow("测试外层事务回滚");
  expect(await h.tx.run((tx) => deletionGuard(tx, entity.id))).toEqual(empty);
  expect(await prisma.billingOrder.count({ where: { entityId: entity.id } })).toBe(before);
}, 60000);
