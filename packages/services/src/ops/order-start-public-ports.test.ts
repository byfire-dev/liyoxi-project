import { afterAll, beforeAll, expect, it } from "vitest";
import { SYSTEM_SCOPE, ownTaskScope } from "../authz/index.js";
import { bindDelivery } from "../delivery/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createIdentityContext, createTxRunner } from "../kernel/index.js";
import { createSla } from "../sla/index.js";
import { pickNext, recommendedStaff } from "../staff/index.js";
import { createTenant } from "../tenant/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  useSeededDatabase,
} from "../testing/index.js";
import { assignDeliveryManager } from "../profile/index.js";
import type { AssignDeliveryManagerDeps } from "../profile/index.js";

const db = useSeededDatabase("services"),
  clock = createClock();
let prisma: Awaited<ReturnType<typeof db.prisma>>,
  tx: ReturnType<typeof createTxRunner>,
  make: ReturnType<typeof createFactories>,
  deps: AssignDeliveryManagerDeps,
  unbind: () => void;
const system = createIdentityContext({
  actor: { type: "system", job: "lyxtest.public_assignment" },
});

beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
  make = createFactories({ db: prisma, clock });
  const assembly = assembleForTest({ entry: "api" }),
    events = createEvents({ tx, clock, assembly }),
    flow = createFlow({ clock, assembly, events }),
    tenant = createTenant({ tx, clock, assembly, flow });
  // 真实订单/交付同步端口均保留；本文件没有交付工单，不调用订单推导链。
  unbind = bindDelivery({ tx, clock, assembly, events, flow, sla: createSla({ clock, assembly }) });
  deps = {
    assembly: { port: assembly.port },
    clock,
    tenant: { setDeliveryManager: tenant.setDeliveryManager },
  };
}, 120000);
afterAll(() => unbind?.());

it("公开首次指派只需窄 deps，真实订单/门店与同步数量审计保持同事务", async () => {
  const order = await make.dramaOrder({ status: "producing" }),
    manager = await make.staff();
  const result = await tx.run((handle) =>
    assignDeliveryManager(handle, deps, system, { storeId: order.storeId, staffId: manager.id }),
  );
  expect(result).toEqual({
    storeId: order.storeId,
    staffId: manager.id,
    assignedAt: clock.now().toISOString(),
    synced: { dramaOrderCount: 1, deliveryTicketCount: 0 },
  });
  expect(await prisma.store.findUniqueOrThrow({ where: { id: order.storeId } })).toMatchObject({
    deliveryManagerId: manager.id,
  });
  expect(await prisma.dramaOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
    deliveryManagerId: manager.id,
  });
  const audit = await prisma.auditLog.findMany({
    where: { storeId: order.storeId, category: "manager_assign" },
  });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "tenant.store.assign_manager",
    meta: { synced: result.synced },
  });
  await expect(
    tx.run((handle) =>
      assignDeliveryManager(handle, deps, system, { storeId: order.storeId, staffId: manager.id }),
    ),
  ).rejects.toMatchObject({ error: "STORE_MANAGER_ASSIGNED" });
  expect(
    await prisma.auditLog.count({ where: { storeId: order.storeId, category: "manager_assign" } }),
  ).toBe(1);
});

it("公开口保留员工必须显式范围、范围外404和接收人范围拒绝", async () => {
  const manager = await make.staff(),
    receiver = await make.staff(),
    store = await make.store(),
    actor = createIdentityContext({ actor: { type: "staff", id: manager.id, client: "admin" } });
  await expect(
    tx.run((handle) =>
      assignDeliveryManager(handle, deps, actor, { storeId: store.id, staffId: manager.id }),
    ),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  await expect(
    tx.run((handle) =>
      assignDeliveryManager(handle, deps, actor, {
        storeId: store.id,
        staffId: manager.id,
        scope: ownTaskScope({ id: manager.id }),
      }),
    ),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  expect(
    await prisma.auditLog.count({ where: { storeId: store.id, category: "manager_assign" } }),
  ).toBe(0);
  await prisma.store.update({ where: { id: store.id }, data: { deliveryManagerId: manager.id } });
  await expect(
    tx.run((handle) =>
      assignDeliveryManager(handle, deps, actor, {
        storeId: store.id,
        staffId: receiver.id,
        scope: ownTaskScope({ id: manager.id }),
      }),
    ),
  ).rejects.toMatchObject({ error: "ASSIGNEE_INVALID", details: { reason: "out_of_scope" } });
  expect(await prisma.store.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({
    deliveryManagerId: manager.id,
  });
  const fresh = await make.store();
  expect(
    await tx.run((handle) =>
      assignDeliveryManager(handle, deps, actor, {
        storeId: fresh.id,
        staffId: manager.id,
        scope: SYSTEM_SCOPE,
      }),
    ),
  ).toMatchObject({ staffId: manager.id, synced: { dramaOrderCount: 0, deliveryTicketCount: 0 } });
});

it("公开推荐只读，保持既有 pickNext 最小工号/非启用/空池语义和零写", async () => {
  const first = await make.staff(),
    second = await make.staff();
  for (const staff of [first, second])
    await prisma.assignmentPoolMember.create({
      data: {
        pool: "delivery_manager",
        staffId: staff.id,
        cityCode: "",
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
  const snapshot = async () =>
    Promise.all([
      prisma.staff.findMany({ orderBy: { id: "asc" } }),
      prisma.assignmentPoolMember.findMany({ orderBy: [{ staffId: "asc" }, { cityCode: "asc" }] }),
      prisma.assignmentCursor.count(),
      prisma.assignmentHistory.count(),
      prisma.auditLog.count(),
      prisma.statusTransition.count(),
      prisma.outboxEvent.count(),
    ]);
  const before = await snapshot();
  await tx.run(async (handle) => {
    const recommended = await recommendedStaff(handle, "delivery_manager");
    expect(recommended).toMatchObject({ staffId: first.id });
    expect(Object.keys(recommended!).sort()).toEqual(
      ["staffId", "staffNo", "name", "roleKey", "isLead", "status"].sort(),
    );
    expect(await pickNext(handle, "delivery_manager", "510100")).toEqual(recommended);
    expect(await pickNext(handle, "delivery_manager", "440300")).toEqual(recommended);
    expect(await recommendedStaff(handle, "cs")).toBeNull();
  });
  expect(await snapshot()).toEqual(before);
  await prisma.staff.update({ where: { id: first.id }, data: { status: "pending" } });
  const pendingBefore = await snapshot();
  expect(await tx.run((handle) => recommendedStaff(handle, "delivery_manager"))).toMatchObject({
    staffId: second.id,
  });
  expect(await snapshot()).toEqual(pendingBefore);
}, 60000);
