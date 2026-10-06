// PR2 真实 worker 装配独立运行全部13检查；主链产物的 full 零违规由 delivery/production-path 另证。
import { it, expect } from "vitest";
import {
  assembleForTest,
  createClock,
  createFactories,
  createProviderHarness,
  useSeededDatabase,
} from "../testing/index.js";
import { createTxRunner, createIdentityContext } from "../kernel/index.js";
import { createTickets, prepareTicketAssignees } from "../delivery/index.js";
import { createFlow } from "../flow/index.js";
import { createMedia } from "../media/index.js";
import { createSla } from "../sla/index.js";
import { buildWorkerServices } from "./worker.js";
import { runInvariants } from "./invariants/index.js";
const db = useSeededDatabase("services");
it("真实worker delivery绑定执行full13检查零违规，媒体桩不依赖API工厂", async () => {
  const prisma = await db.prisma(),
    clock = createClock(),
    assembly = assembleForTest({ entry: "worker" }),
    providers = createProviderHarness({ clock }).providers,
    worker = buildWorkerServices({
      appEnv: "test",
      prisma,
      assembly,
      clock,
      providers,
      channel: { enqueue: async () => {}, downForMs: () => 0 },
    }),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    make = createFactories({ db: prisma, clock }),
    order = await make.dramaOrder({ status: "producing" });
  try {
    await make.orderItem({ dramaOrderId: order.id, phase: "producing" });
    await tx.run(async (t) => {
      await prepareTicketAssignees(t, order.id);
      return createTickets(
        t,
        {
          tx,
          clock,
          assembly,
          flow: createFlow({ clock, assembly, events: worker.events }),
          events: worker.events,
          media: createMedia({
            clock,
            tx,
            assembly,
            events: worker.events,
            storage: providers.storage,
          }),
          sla: createSla({ clock, assembly }),
        },
        createIdentityContext({ actor: { type: "system", job: "lyxtest.delivery" } }),
        { dramaOrderId: order.id },
      );
    });
    expect(
      await runInvariants(
        { tx, assembly: worker.assembly, clock },
        { mode: "full", trigger: "manual", modules: ["delivery"] },
      ),
    ).toMatchObject({ status: "succeeded", checksRun: 13, violationsFound: 0, errors: [] });
  } finally {
    worker.closeDelivery?.();
    worker.closePublish?.();
    worker.closeBillingTimers?.();
  }
}, 120000);
