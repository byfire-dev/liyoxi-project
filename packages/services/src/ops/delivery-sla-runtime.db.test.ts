import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FiredTimer } from "../kernel/index.js";
import { createTxRunner, loadEnv, uuidv7 } from "../kernel/index.js";
import { createRuntime } from "../runtime.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { timerKey } from "../timers/index.js";
import { readCancelReviewPauseTargets, releaseCancelReviewPauses } from "../delivery/index.js";
import { createIdentityContext } from "../kernel/index.js";
import { createSla } from "../sla/index.js";
import { createDeliverySlaAssembly } from "./delivery-sla-runtime.js";
import { buildWorkerServices } from "./worker.js";
const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
const clock = createClock();
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let api: ReturnType<typeof createRuntime>, worker: ReturnType<typeof buildWorkerServices>;
beforeAll(async () => {
  prisma = await db.prisma();
  api = createRuntime({
    entry: "api",
    clock,
    version: "test",
    env: loadEnv({
      APP_ENV: "test",
      DATABASE_URL: await db.url(),
      REDIS_URL: process.env.REDIS_URL,
    }),
    providers: createFakeProviders({ clock }),
    redisKeyPrefix: redis.prefix,
  });
  worker = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createFakeProviders({ clock }),
    channel: { enqueue: async () => {}, downForMs: () => 0 },
  });
}, 120000);
afterAll(async () => {
  await worker?.shutdownMediaJobs?.();
  worker?.closeMediaJobs?.();
  await worker?.closeDocs();
  await worker?.documentConverter?.close();
  await worker?.closeNotify();
  await worker?.closeAnalytics?.();
  await worker?.closeStaff?.();
  await worker?.closeSmsHealth?.();
  await worker?.closeAlertFacts?.();
  worker?.closeOrder?.();
  worker?.closeBillingTimers?.();
  worker?.closePublish?.();
  worker?.closeDelivery?.();
  worker?.closeWebhooks?.();
  await worker?.closeMediaDrivers?.();
  await worker?.closeStorageDrivers?.();
  await api?.close();
});
describe("交付阶段 SLA 固定运行时分发", { timeout: 60000 }, () => {
  it("真实 API 与 worker 唯一 handler 同源；worker 到点 fired，API 重放零事件", async () => {
    const make = createFactories({ db: prisma, clock }),
      ticket = await make.deliveryTicket();
    const snapshot = {
      policy: "ticket.assigning",
      amount: 1,
      unit: "work_days",
      calendarVersion: 1,
      computedAt: clock.now().toISOString(),
    };
    const stage = await prisma.deliveryTicketStage.create({
      data: {
        id: uuidv7(),
        deliveryTicketId: ticket.id,
        step: ticket.step,
        visitNo: 1,
        enteredAt: clock.now(),
        dueAt: clock.now(),
        slaSnapshot: snapshot,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    await prisma.deliveryTicket.update({
      where: { id: ticket.id },
      data: { stepDueAt: stage.dueAt },
    });
    const approvalRequestId = uuidv7();
    await prisma.deliveryTicket.update({
      where: { id: ticket.id },
      data: { pauseCount: 1, pausedAt: clock.now(), pauseRemainingMin: 0 },
    });
    await prisma.deliveryTicketPause.create({
      data: {
        id: uuidv7(),
        deliveryTicketId: ticket.id,
        reason: "cancel_review",
        refType: "approval_request",
        refId: approvalRequestId,
        actorType: "system",
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    await api.tx.run(async (tx) => {
      await releaseCancelReviewPauses(
        tx,
        { ...api, sla: createSla({ clock, assembly: api.assembly }) },
        createIdentityContext({ actor: { type: "system", job: "lyxtest.delivery_resume_due" } }),
        {
          targets: await readCancelReviewPauseTargets(tx, [approvalRequestId]),
          releaseEvent: "withdrawn",
        },
      );
    });
    const armed = await prisma.timer.findFirstOrThrow({
      where: {
        dedupeKey: timerKey("sla.breach", { type: "delivery_ticket_stage", id: stage.id }),
        status: "scheduled",
      },
    });
    await prisma.timer.update({
      where: { id: armed.id },
      data: {
        status: "dispatched",
        dispatchNo: 1,
        leaseUntil: new Date(clock.now().getTime() + 60000),
      },
    });
    for (const runtime of [api, worker]) {
      expect(runtime.assembly.timerHandlers.filter((r) => r.kind === "sla.breach")).toHaveLength(1);
      expect(runtime.assembly.timerHandler("sla.breach")).toBe(
        runtime.assembly.timerHandlers.find((r) => r.kind === "sla.breach"),
      );
    }
    const ref = { timerId: armed.id, dispatchNo: 1, kind: "sla.breach" };
    expect(await worker.runTimer(ref)).toBe("fired");
    expect(
      (await prisma.deliveryTicketStage.findUniqueOrThrow({ where: { id: stage.id } })).isBreached,
    ).toBe(true);
    const input: FiredTimer = {
      id: armed.id,
      kind: "sla.breach",
      subjectType: "delivery_ticket_stage",
      subjectId: stage.id,
      payload: armed.payload as Record<string, unknown>,
    };
    expect(
      await api.tx.run((tx) => api.assembly.timerHandler("sla.breach")!.handle(tx, input)),
    ).toBe("skipped");
    expect(await worker.runTimer(ref)).toBe("stale");
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: ticket.id, eventType: "ticket.sla_breached" },
      }),
    ).toBe(1);
  });
  it("固定包装只处理 stage，approval/staff/其他主体原样委托且关闭互不干扰", async () => {
    const prior: FiredTimer[] = [],
      base = assembleForTest({ entry: "worker" });
    const copy = {
      ...base,
      timerHandlers: base.timerHandlers.map((r) =>
        r.kind === "sla.breach"
          ? {
              ...r,
              handle: async (_tx: Parameters<typeof r.handle>[0], timer: FiredTimer) => {
                prior.push(timer);
                return "skipped" as const;
              },
            }
          : r,
      ),
    };
    const a = createDeliverySlaAssembly(copy),
      b = createDeliverySlaAssembly(copy);
    a.attach({ clock, events: api.events });
    b.attach({ clock, events: api.events });
    const tx = createTxRunner({ prisma, appEnv: "test" });
    for (const subjectType of ["approval_request", "assignment_history", "ad"]) {
      const input = {
        id: uuidv7(),
        kind: "sla.breach",
        subjectType,
        subjectId: uuidv7(),
        payload: null,
      };
      expect(await tx.run((t) => a.assembly.timerHandler("sla.breach")!.handle(t, input))).toBe(
        "skipped",
      );
      expect(prior.at(-1)).toBe(input);
    }
    a.close();
    const input = {
      id: uuidv7(),
      kind: "sla.breach",
      subjectType: "delivery_ticket_stage",
      subjectId: uuidv7(),
      payload: null,
    };
    await expect(
      tx.run((t) => a.assembly.timerHandler("sla.breach")!.handle(t, input)),
    ).rejects.toThrow("已经关闭");
    expect(await tx.run((t) => b.assembly.timerHandler("sla.breach")!.handle(t, input))).toBe(
      "skipped",
    );
    b.close();
    expect(() =>
      createDeliverySlaAssembly({
        ...base,
        timerHandlers: base.timerHandlers.filter((r) => r.kind !== "sla.breach"),
      }),
    ).toThrow("唯一");
  });
  it("真实 worker 绑定的订单重推导在最后恢复后读新步骤，跨订单父锁已完整持有", async () => {
    const make = createFactories({ db: prisma, clock }),
      tickets = [
        await make.deliveryTicket({ step: "ad_prep" }),
        await make.deliveryTicket({ step: "ad_prep" }),
      ];
    const refs: string[] = [];
    for (const ticket of tickets) {
      const ref = uuidv7();
      refs.push(ref);
      await prisma.deliveryTicketStage.create({
        data: {
          id: uuidv7(),
          deliveryTicketId: ticket.id,
          step: ticket.step,
          visitNo: 1,
          enteredAt: clock.now(),
          createdAt: clock.now(),
          updatedAt: clock.now(),
        },
      });
      await prisma.deliveryTicket.update({
        where: { id: ticket.id },
        data: { pauseCount: 1, pausedAt: clock.now() },
      });
      await prisma.deliveryTicketPause.create({
        data: {
          id: uuidv7(),
          deliveryTicketId: ticket.id,
          reason: "cancel_review",
          refType: "approval_request",
          refId: ref,
          actorType: "system",
          createdAt: clock.now(),
          updatedAt: clock.now(),
        },
      });
    }
    const tx = createTxRunner({ prisma, appEnv: "test" });
    const deps = {
      tx,
      clock,
      assembly: worker.assembly,
      flow: api.flow,
      events: worker.events,
      media: api.media,
      sla: createSla({ clock, assembly: worker.assembly }),
    };
    await tx.run(async (t) =>
      releaseCancelReviewPauses(
        t,
        deps,
        createIdentityContext({ actor: { type: "system", job: "lyxtest.real_order_resume" } }),
        { targets: await readCancelReviewPauseTargets(t, refs), releaseEvent: "withdrawn" },
      ),
    );
    for (const ticket of tickets) {
      expect(
        (await prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticket.id } })).step,
      ).toBe("sample_making");
      expect(
        await prisma.dramaOrder.findUniqueOrThrow({ where: { id: ticket.dramaOrderId } }),
      ).toMatchObject({ status: "producing", subStatus: "sample_making" });
    }
  });
});
