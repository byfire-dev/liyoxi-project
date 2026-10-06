import type { PrismaClient } from "@liyoxi/db";
import { assembleForTest, TEST_KEYRING } from "../../testing/index.js";
import { alertsPort, defineRegistration, implement, uuidv7 } from "../../kernel/index.js";
import type { AlertInput } from "../../kernel/index.js";
import { createFlow } from "../../flow/index.js";
import { createTenant } from "../../tenant/index.js";
import { createApproval } from "../../approval/index.js";
import { createProfile } from "../../profile/index.js";
import { bindDelivery } from "../../delivery/index.js";
import { createSla } from "../../sla/index.js";
import { createMedia } from "../../media/index.js";
import { createTimers } from "../../timers/index.js";
import { staffBriefs } from "../../staff/index.js";
import { bindOrder } from "../binding.js";
import { bindOrderStart } from "../start-binding.js";
import type { OrderStartBinding } from "../start-binding.js";
import { harness, buyer, drama, version, body } from "./harness.js";

export function startHarness(prisma: PrismaClient, options: Parameters<typeof harness>[1] = {}) {
  const h = harness(prisma, options),
    alerts: AlertInput[] = [],
    assembly = assembleForTest({
      entry: "worker",
      extra: [
        defineRegistration("lyxtest_order_start", {
          portImplementations: [
            implement(alertsPort, {
              raise: async (input) => {
                alerts.push(input);
              },
            }),
          ],
        }),
      ],
    }),
    flow = createFlow({ assembly, clock: h.clock, events: h.events }),
    core = {
      tx: h.tx,
      clock: h.clock,
      assembly,
      flow,
      events: h.events,
      sla: createSla({ clock: h.clock, assembly }),
    },
    tenant = createTenant(core),
    media = createMedia({ ...core, storage: h.fake.storage }),
    profile = createProfile({
      ...core,
      tenant,
      media,
      approval: createApproval({ ...core, bizNo: h.deps.bizNo }),
      keyring: () => TEST_KEYRING,
      wechat: h.fake.wechat,
      currentOpenid: async () => "lyxtest_start_openid",
    });
  const deps: OrderStartBinding = {
    ...core,
    ledger: h.ledger,
    timers: createTimers({ assembly }),
    // 开工测试在 companion 公开 reader 实际合入前注入等价窄 reader；不依赖其未合源码。
    recommendStaff: async (tx, pool) => {
      const row = await tx.staff.findFirst({
        where: { status: "active", assignmentPoolMembers: { some: { pool } } },
        orderBy: [{ staffNo: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      return row ? (await staffBriefs(tx, [row.id]))[0]! : null;
    },
    assignManager: (tx, ctx, input) => profile.assignDeliveryManager(tx, ctx, input),
  };
  const clearOrder = bindOrder(core),
    clearDelivery = bindDelivery(core),
    clearStart = bindOrderStart(deps);
  async function pending(
    input: { count?: number; gate?: "full" | "parallel"; managerId?: string } = {},
  ) {
    await version(h);
    const b = await buyer(h, { gate: input.gate ?? "full" });
    if (input.managerId)
      await prisma.store.update({
        where: { id: b.store.id },
        data: { deliveryManagerId: input.managerId },
      });
    const dramas = [];
    for (let i = 0; i < (input.count ?? 1); i++) dramas.push(await drama(h, 100));
    const order = await h.order.create(
        b.actor,
        await body(
          h,
          b,
          dramas.map((d) => d.id),
        ),
      ),
      items = await prisma.orderItem.findMany({
        where: { dramaOrderId: order.orderId },
        orderBy: { id: "asc" },
      });
    return { b, dramas, order, id: order.orderId, items };
  }
  async function pool(pool: "delivery_manager" | "publisher", id?: string) {
    const staff = await h.make.staff({ staffRoleKey: pool, ...(id ? { id } : {}) });
    await prisma.assignmentPoolMember.create({
      data: { pool, staffId: staff.id, createdAt: h.clock.now(), updatedAt: h.clock.now() },
    });
    return staff;
  }
  return {
    ...h,
    assembly,
    flow,
    core,
    orderDeps: h.deps,
    deps,
    alerts,
    pending,
    pool,
    clear: () => {
      clearStart();
      clearDelivery();
      clearOrder();
    },
  };
}
export type StartHarness = ReturnType<typeof startHarness>;
export async function startSnapshot(h: StartHarness, entityId: string) {
  return Promise.all([
    h.prisma.dramaOrder.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    h.prisma.orderItem.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    h.prisma.pointHold.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    h.prisma.ledgerOperation.count({ where: { entityId } }),
    h.prisma.pointLedgerEntry.count({ where: { entityId } }),
    h.prisma.statusTransition.count({ where: { entityId } }),
    h.prisma.auditLog.count({ where: { entityId } }),
    h.prisma.outboxEvent.count({ where: { entityId } }),
    h.prisma.deliveryTicket.count({ where: { entityId } }),
    h.prisma.deliveryPlan.count({ where: { entityId } }),
    h.prisma.billingAccount.findUnique({ where: { entityId } }),
    h.prisma.pointLot.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
  ]);
}
let cancelSeq = 60000;
export async function pendingCancel(
  h: StartHarness,
  p: Awaited<ReturnType<StartHarness["pending"]>>,
) {
  const id = uuidv7(),
    approvalId = uuidv7(),
    now = h.clock.now(),
    requester = await h.make.staff({ staffRoleKey: "cs" });
  await h.prisma.approvalRequest.create({
    data: {
      id: approvalId,
      requestNo: `TK20260105${++cancelSeq}`,
      kind: "qualification_cancel",
      category: "approval",
      subjectType: "store",
      subjectId: p.b.store.id,
      entityId: p.b.entity.id,
      storeId: p.b.store.id,
      status: "pending",
      summarySnapshot: { title: "测试在途取消" },
      requesterStaffId: requester.id,
      submitActorType: "system",
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.prisma.cancelRequest.create({
    data: {
      id,
      approvalRequestId: approvalId,
      kind: "qualification_cancel",
      entityId: p.b.entity.id,
      storeId: p.b.store.id,
      reasonCode: "qualification_final",
      note: "测试开工在途取消守卫",
      lineCount: 1,
      totalBasePoints: 100,
      totalDeductPoints: 0,
      totalRefundPoints: 100,
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.prisma.dramaOrder.update({
    where: { id: p.id },
    data: { status: "after_sale", subStatus: "cancel_reviewing", openCancelRequestId: id },
  });
  return id;
}
