import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bindBillingTimers,
  buildWorkerServices,
  handleTransferTtl,
  uuidv7,
} from "@liyoxi/services";
import {
  applyReceipt,
  assembleForTest,
  createPaymentHarness,
  pendingPlanOrder,
  transferReceipt,
  useSeededDatabase,
} from "@liyoxi/services/testing";
import { createWorkerRuntime } from "../src/runtime.js";
import { silentLogger } from "../src/log.js";
import type { QueueChannel, WorkerServices } from "@liyoxi/services";
const db = useSeededDatabase("worker");
let h: ReturnType<typeof createPaymentHarness>, services: WorkerServices;
let restore: () => void;
beforeAll(async () => {
  h = createPaymentHarness(await db.prisma());
  const assembly = assembleForTest({ entry: "worker" });
  services = buildWorkerServices({
    appEnv: "test",
    prisma: h.prisma,
    assembly,
    clock: h.clock,
    channel: { enqueue: async () => {}, downForMs: () => 0 },
  });
  restore = bindBillingTimers({
    clock: h.clock,
    flow: h.paymentDeps.flow,
    timers: services.timers,
  });
}, 180_000);
afterAll(() => {
  restore?.();
  services.closeBillingTimers?.();
});
async function setup(status: "pending_payment" | "pending_confirmation" = "pending_payment") {
  const { entity, user } = await h.make.merchant({ verified: true }),
    order = await pendingPlanOrder(h, { entityId: entity.id, status });
  const timer = await h.tx.run((tx) =>
    services.timers.arm(tx, {
      kind: "po.transfer_ttl",
      subject: { type: "billing_order", id: order.id },
      fireAt: order.expiresAt,
      key: `po.transfer_ttl:billing_order:${order.id}:${order.expiresAt.getTime()}`,
      payload: { expiresAt: order.expiresAt.toISOString() },
      entityId: order.entityId,
    }),
  );
  return { order, timer, user };
}
async function fire(timerId: string) {
  await h.prisma.timer.update({
    where: { id: timerId },
    data: {
      status: "dispatched",
      dispatchNo: 1,
      leaseUntil: new Date(h.clock.now().getTime() + 300_000),
    },
  });
  return services.runTimer({ timerId, dispatchNo: 1, kind: "po.transfer_ttl" });
}
describe("对公付款 TTL 的真实 worker 执行", () => {
  it("到期取消一次，取消原因与单条历史/事件同事务，队列重复为 stale", async () => {
    const { order, timer } = await setup();
    h.clock.set(order.expiresAt);
    expect(await fire(timer.id)).toBe("fired");
    expect(
      await h.prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } }),
    ).toMatchObject({ status: "cancelled", cancelReason: "transfer_ttl", transferState: null });
    expect(
      await services.runTimer({ timerId: timer.id, dispatchNo: 1, kind: "po.transfer_ttl" }),
    ).toBe("stale");
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: order.id, event: "billing_order.cancel" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.outboxEvent.count({
        where: {
          dedupeKey: `tmr:po.transfer_ttl:billing_order:${order.id}:${order.expiresAt.getTime()}`,
        },
      }),
    ).toBe(1);
  }, 60_000);
  it("到点见待确认凭证 skipped，并保持待确认状态", async () => {
    const { order, timer, user } = await setup("pending_confirmation"),
      file = await h.make.fileObject({
        category: "pay_receipt",
        bucket: "secure",
        scopeType: "entity",
        entityId: order.entityId,
      }),
      now = h.clock.now();
    await h.prisma.transferProof.create({
      data: {
        id: uuidv7(),
        entityId: order.entityId,
        billingOrderId: order.id,
        uploadNo: 1,
        fileId: file.id,
        uploadedByUserId: user.id,
        uploadedAt: now,
        reviewStatus: "pending",
        createdAt: now,
        updatedAt: now,
      },
    });
    h.clock.set(order.expiresAt);
    expect(await fire(timer.id)).toBe("skipped");
    expect(
      (await h.prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("pending_confirmation");
  }, 60_000);
  it("旧有效期任务不取消顺延的新单，已支付任务成为 stale", async () => {
    const { order, timer } = await setup();
    const later = new Date(order.expiresAt.getTime() + 86_400_000);
    await h.prisma.billingOrder.update({ where: { id: order.id }, data: { expiresAt: later } });
    h.clock.set(order.expiresAt);
    expect(await fire(timer.id)).toBe("skipped");
    const second = await h.tx.run((tx) =>
      services.timers.arm(tx, {
        kind: "po.transfer_ttl",
        subject: { type: "billing_order", id: order.id },
        fireAt: later,
        key: `po.transfer_ttl:billing_order:${order.id}:${later.getTime()}`,
        payload: { expiresAt: later.toISOString() },
      }),
    );
    await applyReceipt(h, await transferReceipt(h, order));
    expect(
      await services.runTimer({ timerId: second.id, dispatchNo: 0, kind: "po.transfer_ttl" }),
    ).toBe("stale");
  }, 60_000);
  it("乱序关闭作用域不会恢复已经撤销的绑定", async () => {
    const a = bindBillingTimers({
        clock: h.clock,
        flow: h.paymentDeps.flow,
        timers: services.timers,
      }),
      b = bindBillingTimers({ clock: h.clock, flow: h.paymentDeps.flow, timers: services.timers });
    a();
    b();
    const { order, timer } = await setup();
    h.clock.set(order.expiresAt);
    expect(await fire(timer.id)).toBe("fired");
  }, 60_000);
  it("worker stop 收完消费者后解绑，重复 stop 以及关闭出错也不泄漏", async () => {
    restore();
    services.closeBillingTimers?.();
    const a = bindBillingTimers({
      clock: h.clock,
      flow: h.paymentDeps.flow,
      timers: services.timers,
    });
    const b = bindBillingTimers({
      clock: h.clock,
      flow: h.paymentDeps.flow,
      timers: services.timers,
    });
    const inert = {
      id: uuidv7(),
      kind: "po.transfer_ttl",
      subjectType: null,
      subjectId: null,
      payload: null,
    };
    a();
    expect(await h.tx.run((tx) => handleTransferTtl(tx, inert))).toBe("skipped");
    b();
    await expect(h.tx.run((tx) => handleTransferTtl(tx, inert))).rejects.toThrow("未绑定");
    for (const failClose of [false, true]) {
      const close = bindBillingTimers({
        clock: h.clock,
        flow: h.paymentDeps.flow,
        timers: services.timers,
      });
      let closes = 0;
      let releases = 0;
      const channel: QueueChannel = {
        enqueue: async () => {},
        downForMs: () => 0,
        ping: async () => true,
        close: async () => {},
        consume: () => ({
          start() {},
          pause: async () => {},
          close: async () => {
            if (closes++ < 3)
              expect(await h.tx.run((tx) => handleTransferTtl(tx, inert))).toBe("skipped");
            if (failClose) throw new Error("consumer close failed");
          },
        }),
      };
      const runtime = createWorkerRuntime({
        services: { ...services, closeBillingTimers: close },
        channel,
        lease: {
          holder: "shutdown-test",
          renew: async () => true,
          close: async () => {},
          release: async () => {
            expect(closes).toBe(5);
            expect(await h.tx.run((tx) => handleTransferTtl(tx, inert))).toBe("skipped");
            releases++;
            return true;
          },
        },
        logger: silentLogger,
      });
      if (failClose) await expect(runtime.stop()).rejects.toThrow("consumer close failed");
      else {
        await runtime.stop();
        await runtime.stop();
      }
      expect(releases).toBe(failClose ? 0 : 1);
      await expect(h.tx.run((tx) => handleTransferTtl(tx, inert))).rejects.toThrow("未绑定");
    }
  }, 60_000);
  it("一个关闭立即失败、另一个仍在途时不提前解绑；循环失败仍关闭消费者", async () => {
    for (const loopFails of [false, true]) {
      const inert = {
        id: uuidv7(),
        kind: "po.transfer_ttl",
        subjectType: null,
        subjectId: null,
        payload: null,
      };
      const close = bindBillingTimers({
        clock: h.clock,
        flow: h.paymentDeps.flow,
        timers: services.timers,
      });
      let cleaned = 0;
      let releases = 0;
      let finish!: () => void, entered!: () => void;
      const delayed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const channel: QueueChannel = {
        enqueue: async () => {},
        downForMs: () => 0,
        ping: async () => true,
        close: async () => {},
        consume: (queue) => ({
          start() {},
          pause: async () => {},
          close: async () => {
            if (queue === "outbox_delivery") throw new Error("consumer failed");
            if (queue === "media_job") {
              entered();
              await delayed;
            }
          },
        }),
      };
      const runtime = createWorkerRuntime({
        services: {
          ...services,
          closeBillingTimers() {
            cleaned++;
            close();
          },
        },
        channel,
        lease: {
          holder: "shutdown-test",
          renew: async () => true,
          close: async () => {},
          release: async () => {
            releases++;
            return true;
          },
        },
        logger: silentLogger,
      });
      if (loopFails)
        runtime.loops.timer_scan.stop = async () => {
          throw new Error("loop failed");
        };
      const stopped = runtime.stop();
      await started;
      expect(cleaned).toBe(0);
      expect(releases).toBe(0);
      expect(await h.tx.run((tx) => handleTransferTtl(tx, inert))).toBe("skipped");
      finish();
      await expect(stopped).rejects.toThrow(loopFails ? "loop failed" : "consumer failed");
      await expect(runtime.stop()).rejects.toThrow(loopFails ? "loop failed" : "consumer failed");
      expect(cleaned).toBe(1);
      expect(releases).toBe(0);
      await expect(h.tx.run((tx) => handleTransferTtl(tx, inert))).rejects.toThrow("未绑定");
    }
  }, 60_000);
});
