import { expect, it } from "vitest";
import {
  useSeededDatabase,
  createClock,
  assembleForTest,
  createFactories,
  createFakeProviders,
} from "../testing/index.js";
import { createTxRunner, createIdentityContext } from "../kernel/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createSla } from "../sla/index.js";
import { createTickets, prepareTicketAssignees, orderSidePort } from "../delivery/index.js";
import { buildWorkerServices } from "./worker.js";
import { runInvariants } from "./invariants/index.js";
const db = useSeededDatabase("services");
it("独立worker真实绑定运行order六检查，自愈合法前向事实并留告警；关闭后拒绝空转", async () => {
  const prisma = await db.prisma(),
    clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    assembly = assembleForTest({ entry: "worker" }),
    make = createFactories({ db: prisma, clock });
  const worker = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    assembly,
    providers: createFakeProviders({ clock }),
    channel: { enqueue: async () => {}, downForMs: () => 0 },
  });
  try {
    const order = await make.dramaOrder({ status: "producing" }),
      item = await make.orderItem({ dramaOrderId: order.id, phase: "producing" });
    const manager = await make.staff({ staffRoleKey: "delivery_manager" });
    await prisma.store.update({
      where: { id: order.storeId },
      data: { deliveryManagerId: manager.id },
    });
    await prisma.dramaOrder.update({
      where: { id: order.id },
      data: { deliveryManagerId: manager.id },
    });
    const events = createEvents({ tx, clock, assembly }),
      flow = createFlow({ clock, assembly, events }),
      core = { tx, clock, assembly, events, flow, sla: createSla({ assembly, clock }) };
    const made = await tx.run(async (t) => {
      await prepareTicketAssignees(t, order.id);
      return createTickets(
        t,
        core,
        createIdentityContext({ actor: { type: "system", job: "lyxtest.order" } }),
        { dramaOrderId: order.id },
      );
    });
    await prisma.deliveryTicket.update({
      where: { id: made.deliveryTicketIds[0]! },
      data: { step: "awaiting_launch" },
    });
    const result = await runInvariants(
      { tx, clock, assembly: worker.assembly },
      { mode: "full", trigger: "manual", modules: ["order"], entityIds: [order.entityId] },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      checksRun: 6,
      violationsFound: 1,
      errors: [],
    });
    expect(await prisma.orderItem.findUnique({ where: { id: item.id } })).toMatchObject({
      phase: "to_launch",
    });
    expect(await prisma.dramaOrder.findUnique({ where: { id: order.id } })).toMatchObject({
      status: "to_launch",
    });
    expect(
      await prisma.invariantViolation.findFirst({
        where: { subjectId: item.id, code: "order.I3" },
      }),
    ).toMatchObject({ autoHealedAt: clock.now(), resolvedAt: null });
    expect(await prisma.statusTransition.count({ where: { subjectId: item.id } })).toBe(1);
    const again = await runInvariants(
      { tx, clock, assembly: worker.assembly },
      { mode: "full", trigger: "manual", modules: ["order"], entityIds: [order.entityId] },
    );
    expect(again).toMatchObject({
      status: "succeeded",
      checksRun: 6,
      violationsFound: 0,
      errors: [],
    });
    expect(await prisma.statusTransition.count({ where: { subjectId: item.id } })).toBe(1);
  } finally {
    worker.closeOrder?.();
    worker.closeDelivery?.();
    worker.closePublish?.();
    worker.closeBillingTimers?.();
  }
  await expect(
    tx.run((t) => assembly.port(orderSidePort).rederive(t, { orderItemIds: [] })),
  ).rejects.toMatchObject({ error: "INTERNAL" });
}, 120000);
