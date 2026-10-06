import { beforeAll, describe, it, expect } from "vitest";
import {
  createFactories,
  createSampleEvents,
  useSeededDatabase,
  useTestRedis,
} from "@liyoxi/services/testing";
import {
  createFlow,
  createIdentityContext,
  createSla,
  createTickets,
  prepareTicketAssignees,
} from "@liyoxi/services";
import { DOMAIN_LOOPS } from "../src/domain-loops.js";
import { createHarness, SLOW } from "./support/harness.js";
import type { Harness } from "./support/harness.js";
const db = useSeededDatabase("worker"),
  redis = useTestRedis();
let h: Harness;
beforeAll(async () => {
  h = await createHarness(db, redis);
}, SLOW);
describe("delivery 真实 worker 循环", () => {
  it("flow_reevaluate_sweep 每五分钟，实际运行时收到并只补偿一次", async () => {
    const worker = await h.instance(),
      clock = worker.clock,
      make = createFactories({ db: h.prisma, clock }),
      manager = await make.staff({ staffRoleKey: "delivery_manager" }),
      merchant = await make.subscribedMerchant();
    await h.prisma.store.update({
      where: { id: merchant.store.id },
      data: { deliveryManagerId: manager.id },
    });
    const order = await make.dramaOrder({
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
        status: "producing",
      }),
      item = await make.orderItem({ dramaOrderId: order.id, phase: "producing" }),
      s = worker.services;
    const { tx } = createSampleEvents(h.prisma),
      flow = createFlow({ assembly: s.assembly, clock, events: s.events }),
      created = await tx.run(async (t) => {
        await prepareTicketAssignees(t, order.id);
        return createTickets(
          t,
          {
            tx,
            clock,
            assembly: s.assembly,
            flow,
            events: s.events,
            sla: createSla({ clock, assembly: s.assembly }),
          },
          createIdentityContext({ actor: { type: "system", job: "lyxtest.worker" } }),
          { dramaOrderId: order.id },
        );
      });
    const id = created.deliveryTicketIds[0]!;
    await h.prisma.deliveryTicket.update({ where: { id }, data: { step: "ad_prep" } });
    await h.prisma.deliveryTicketStage.updateMany({
      where: { deliveryTicketId: id, completedAt: null },
      data: { step: "ad_prep" },
    });
    expect(DOMAIN_LOOPS.find((l) => l.name === "flow_reevaluate_sweep")?.intervalMs).toBe(300000);
    expect(worker.runtime.domainLoops["flow_reevaluate_sweep"]?.name).toBe("flow_reevaluate_sweep");
    await worker.runtime.domainLoops["flow_reevaluate_sweep"]?.tick();
    await worker.runtime.domainLoops["flow_reevaluate_sweep"]?.tick();
    expect((await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } })).step).toBe(
      "sample_making",
    );
    expect(
      await h.prisma.statusTransition.count({ where: { subjectId: id, event: "ads.ready" } }),
    ).toBe(1);
    expect(item.id).toBeTruthy();
  });
});
