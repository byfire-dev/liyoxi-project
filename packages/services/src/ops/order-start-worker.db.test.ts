import { expect, it } from "vitest";
import {
  useSeededDatabase,
  createClock,
  assembleForTest,
  createFactories,
  createFakeProviders,
  prepareOrderFixture,
} from "../testing/index.js";
import {
  createTxRunner,
  createIdentityContext,
  createBizNoIssuer,
  uuidv7,
} from "../kernel/index.js";
import { createOrderService } from "../order/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createTimers } from "../timers/index.js";
import { createLedger } from "../billing/index.js";
import { createContent } from "../content/index.js";
import { createMedia } from "../media/index.js";
import { createConfig } from "../config/index.js";
import { createDocs } from "../docs/index.js";
import { buildWorkerServices } from "./worker.js";

const db = useSeededDatabase("services");
it("独立worker实际relay/派发/消费两订阅者后真实扣减开工；重复无写且close解绑", async () => {
  const prisma = await db.prisma(),
    clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    assembly = assembleForTest({ entry: "worker" }),
    providers = createFakeProviders({ clock }),
    make = createFactories({ db: prisma, clock }),
    events = createEvents({ assembly, clock, tx }),
    flow = createFlow({ assembly, clock, events }),
    timers = createTimers({ assembly }),
    media = createMedia({ tx, clock, assembly, events, storage: providers.storage }),
    order = createOrderService({
      tx,
      clock,
      assembly,
      events,
      timers,
      media,
      bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
      ledger: createLedger({ clock, events }),
      config: createConfig({ db: prisma, clock, redis: null, report: () => {} }),
      content: createContent({ clock, assembly, flow, media }),
      docs: createDocs({ tx, clock }),
    });
  const queued: Array<{ eventId: string; subscriber: string; dispatchNo: number }> = [];
  const worker = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    assembly,
    providers,
    channel: {
      enqueue: async (_queue, _id, payload) => {
        if (typeof payload === "object" && payload !== null && "eventId" in payload)
          queued.push(payload as { eventId: string; subscriber: string; dispatchNo: number });
      },
      downForMs: () => 0,
    },
  });
  let orderId = "";
  try {
    const merchant = await make.merchant({ verified: true }),
      member = await prisma.entityMember.findFirstOrThrow({
        where: {
          entityId: merchant.entity.id,
          merchantUserId: merchant.user.id,
        },
      });
    const f = await prepareOrderFixture(prisma, { order }, clock, {
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      memberId: member.id,
      merchantUserId: merchant.user.id,
    });
    await prisma.store.update({
      where: { id: merchant.store.id },
      data: { qualificationStatus: "pending", isPrimary: true },
    });
    const made = await order.create(f.actor, f.input);
    orderId = made.orderId;
    const before = await order.get(f.actor, orderId);
    expect(before.items[0]!.ticketStep).toBeNull();
    expect(before.deliveryPlan).toBeNull();
    const manager = await make.staff({ staffRoleKey: "delivery_manager" });
    await prisma.assignmentPoolMember.create({
      data: {
        pool: "delivery_manager",
        staffId: manager.id,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    const term = await prisma.subscriptionTerm.findFirstOrThrow({
        where: { entityId: merchant.entity.id },
      }),
      ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.order_start" } });
    await tx.run((t) =>
      events.emit(t, ctx, {
        type: "billing.subscription.activated",
        aggregate: { type: "subscription_term", id: term.id },
        entityId: merchant.entity.id,
        dedupeKey: `lyxtest-start-sub:${orderId}`,
        payload: {
          v: 1,
          entityId: merchant.entity.id,
          termId: term.id,
          planId: term.planId,
          startsAt: term.startsAt.toISOString(),
          endsAt: term.endsAt.toISOString(),
          sourceBillingOrderId: uuidv7(),
        },
      }),
    );
    await worker.relay();
    await worker.dispatch();
    const subscription = queued.find((r) => r.subscriber === "order.onSubscriptionActivated")!;
    expect(subscription).toBeDefined();
    expect(await worker.consume(subscription)).toBe("done");
    expect(await prisma.store.findUnique({ where: { id: merchant.store.id } })).toMatchObject({
      deliveryManagerId: manager.id,
    });
    expect(await prisma.dramaOrder.findUnique({ where: { id: orderId } })).toMatchObject({
      deliveryManagerId: manager.id,
      status: "pending_start",
    });
    expect(await worker.consume(subscription)).toBe("stale");
    await prisma.store.update({
      where: { id: merchant.store.id },
      data: { qualificationStatus: "verified" },
    });
    await tx.run((t) =>
      events.emit(t, ctx, {
        type: "store.qualification.approved",
        aggregate: { type: "store", id: merchant.store.id },
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
        dedupeKey: `lyxtest-start-qual:${orderId}`,
        payload: {
          v: 1,
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
          submissionId: uuidv7(),
          kind: "initial",
        },
      }),
    );
    await worker.relay();
    await worker.dispatch();
    const qualification = queued.find((r) => r.subscriber === "order.onQualificationDecided")!;
    expect(await worker.consume(qualification)).toBe("done");
    expect(await worker.consume(qualification)).toBe("stale");
    const timer = await prisma.timer.findFirstOrThrow({
      where: { subjectId: orderId, kind: "order.start" },
    });
    await prisma.timer.update({
      where: { id: timer.id },
      data: {
        status: "dispatched",
        dispatchNo: 1,
        leaseUntil: new Date(clock.now().getTime() + 300000),
      },
    });
    const ref = { timerId: timer.id, kind: "order.start", dispatchNo: 1 };
    expect(await worker.runTimer(ref)).toBe("fired");
    expect(await worker.runTimer(ref)).toBe("stale");
    expect(await prisma.dramaOrder.findUnique({ where: { id: orderId } })).toMatchObject({
      status: "producing",
    });
    expect(
      await prisma.deliveryTicket.findFirst({ where: { dramaOrderId: orderId } }),
    ).toMatchObject({ step: "plan_confirm", deliveryManagerId: manager.id });
    expect(
      await prisma.ledgerOperation.count({
        where: { entityId: merchant.entity.id, opType: "capture" },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: "order.started", aggregateId: orderId },
      }),
    ).toBe(1);
    const after = await order.get(f.actor, orderId);
    expect(after.items[0]!.ticketStep).toBe("plan_confirm");
    expect(after.deliveryPlan).not.toBeNull();
    expect(after.startedAt).toBe(clock.now().toISOString());
    expect(after.items[0]!.timeline.find((t) => t.key === "started")).toMatchObject({
      state: "done",
      at: clock.now().toISOString(),
    });
    expect(after.pointsEvents.find((e) => e.opType === "capture")).toMatchObject({
      points: after.totalChargePoints,
      occurredAt: clock.now().toISOString(),
    });
  } finally {
    worker.closeOrder?.();
    worker.closeDelivery?.();
    worker.closePublish?.();
    worker.closeBillingTimers?.();
  }
  await expect(
    tx.run((t) =>
      assembly.timerHandler("order.start")!.handle(t, {
        id: uuidv7(),
        kind: "order.start",
        subjectType: "drama_order",
        subjectId: orderId,
        payload: {},
      }),
    ),
  ).rejects.toMatchObject({ error: "INTERNAL" });
}, 120000);
