import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, expect, it } from "vitest";
import { createTxRunner } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { createClock, createFactories, useSeededDatabase } from "../testing/index.js";
import { countBlockingStoreTickets, countOnlineReleaseTicketsByEntity } from "./index.js";

const db = useSeededDatabase("services", { max: 1 });
const clock = createClock();
let prisma: PrismaClient;
let tx: ReturnType<typeof createTxRunner>;
beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
}, 120000);

const steps = [
  "assigning",
  "plan_confirm",
  "ad_prep",
  "sample_making",
  "sample_confirm",
  "batch_compose",
  "delivering",
  "awaiting_launch",
  "launch_verify",
  "in_service",
  "takedown",
  "archived",
  "terminated",
] as const;

async function seedTickets(
  connection: PrismaClient | Tx,
  storeId: string,
  wanted: readonly string[],
) {
  const make = createFactories({ db: connection, clock });
  const order = await make.dramaOrder({
    storeId,
    status: "producing",
    itemCount: wanted.length,
    totalChargePoints: 100 * wanted.length,
  });
  const manager = await make.staff();
  const drama = await make.drama();
  for (const step of wanted) {
    const item = await make.orderItem({
      dramaOrderId: order.id,
      dramaId: drama.id,
      phase: "producing",
    });
    await make.deliveryTicket({ orderItemId: item.id, step, deliveryManagerId: manager.id });
  }
}

it("覆盖十三个正式步骤，隔离主体与门店且主体汇总自己的全部门店", async () => {
  const make = createFactories({ db: prisma, clock });
  const a = await make.merchant();
  const sibling = await make.store({ entityId: a.entity.id });
  const b = await make.merchant();
  const empty = await make.merchant();
  await seedTickets(prisma, a.store.id, steps);
  await seedTickets(prisma, sibling.id, ["awaiting_launch"]);
  await seedTickets(prisma, b.store.id, ["in_service"]);
  await tx.run(async (t) => {
    expect(await countBlockingStoreTickets(t, a.store.id)).toBe(11);
    expect(await countBlockingStoreTickets(t, sibling.id)).toBe(1);
    expect(await countBlockingStoreTickets(t, b.store.id)).toBe(1);
    expect(await countBlockingStoreTickets(t, empty.store.id)).toBe(0);
    expect(await countOnlineReleaseTicketsByEntity(t, a.entity.id)).toBe(5);
    expect(await countOnlineReleaseTicketsByEntity(t, b.entity.id)).toBe(1);
    expect(await countOnlineReleaseTicketsByEntity(t, empty.entity.id)).toBe(0);
  });
}, 60000);

it("重复读取保留工单、订单、阶段、审计、历史及出站证据", async () => {
  const make = createFactories({ db: prisma, clock });
  const a = await make.merchant();
  await seedTickets(prisma, a.store.id, ["delivering", "takedown", "archived", "terminated"]);
  const snapshot = async () => ({
    tickets: await prisma.deliveryTicket.findMany({
      where: { entityId: a.entity.id },
      orderBy: { id: "asc" },
    }),
    orders: await prisma.dramaOrder.findMany({
      where: { entityId: a.entity.id },
      orderBy: { id: "asc" },
    }),
    items: await prisma.orderItem.findMany({
      where: { entityId: a.entity.id },
      orderBy: { id: "asc" },
    }),
    stages: await prisma.deliveryTicketStage.count(),
    history: await prisma.statusTransition.count(),
    audit: await prisma.auditLog.count(),
    outbox: await prisma.outboxEvent.count(),
  });
  const before = await snapshot();
  for (let n = 0; n < 2; n++) {
    await tx.run(async (t) => {
      expect(await countBlockingStoreTickets(t, a.store.id)).toBe(2);
      expect(await countOnlineReleaseTicketsByEntity(t, a.entity.id)).toBe(1);
    });
  }
  expect(await snapshot()).toEqual(before);
}, 60000);

it("只读调用方未提交的工单，外层失败完整回滚", async () => {
  const make = createFactories({ db: prisma, clock });
  const a = await make.merchant();
  await expect(
    tx.run(async (t) => {
      await seedTickets(t, a.store.id, ["awaiting_launch"]);
      expect(await countBlockingStoreTickets(t, a.store.id)).toBe(1);
      expect(await countOnlineReleaseTicketsByEntity(t, a.entity.id)).toBe(1);
      throw new Error("测试调用方回滚");
    }),
  ).rejects.toThrow("测试调用方回滚");
  await tx.run(async (t) => {
    expect(await countBlockingStoreTickets(t, a.store.id)).toBe(0);
    expect(await countOnlineReleaseTicketsByEntity(t, a.entity.id)).toBe(0);
  });
  expect(await prisma.dramaOrder.count({ where: { entityId: a.entity.id } })).toBe(0);
  expect(await prisma.deliveryTicket.count({ where: { entityId: a.entity.id } })).toBe(0);
}, 60000);
