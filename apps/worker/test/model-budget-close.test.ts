import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildWorkerServices } from "@liyoxi/services";
import type { WorkerServicesOptions, QueueChannel, QueueConsumer } from "@liyoxi/services";
import { assembleForTest, useSeededDatabase } from "@liyoxi/services/testing";
import { createWorkerRuntime, SHUTDOWN_WAIT_MS } from "../src/runtime.js";
import { silentLogger } from "../src/log.js";

const db = useSeededDatabase("worker", { max: 1, label: "budgetclose" }),
  SLOW = 240000;
type BudgetTransport = NonNullable<WorkerServicesOptions["modelBudgetTransport"]>;
let prisma: Awaited<ReturnType<typeof db.prisma>>;
beforeAll(async () => {
  prisma = await db.prisma();
}, SLOW);
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
function instance(evaluate = vi.fn<BudgetTransport["eval"]>(async () => ["maintained", 0, 0])) {
  const consumers: QueueConsumer[] = [];
  // 队列IO是受控替身；真正的runtime.stop、服务装配、PG扫描和预算ledger保持原实现。
  const channel: QueueChannel = {
    enqueue: vi.fn(async () => undefined),
    downForMs: () => 0,
    ping: async () => true,
    close: vi.fn(async () => undefined),
    consume() {
      const consumer = {
        start: vi.fn(),
        pause: vi.fn(async () => undefined),
        close: vi.fn(async (_timeout: number) => undefined),
      };
      consumers.push(consumer);
      return consumer;
    },
  };
  const services = buildWorkerServices({
    appEnv: "test",
    prisma,
    assembly: assembleForTest({ entry: "worker" }),
    channel,
    modelBudgetTransport: { eval: evaluate },
    logger: silentLogger,
  });
  const runtime = createWorkerRuntime({ services, channel, logger: silentLogger });
  return { services, runtime, channel, consumers, evaluate };
}

describe("实际worker预算生命周期", { timeout: SLOW }, () => {
  it("构造零EVAL，沿原media扫描节奏维护，消费者drain后才close预算/告警", async () => {
    const one = instance(),
      entered = deferred(),
      gate = deferred();
    expect(one.evaluate).not.toHaveBeenCalled();
    await one.services.scanPromote();
    expect(one.evaluate).toHaveBeenCalledOnce();
    expect(one.evaluate.mock.calls[0]?.[1]).toEqual(["lyx:test:model_budget:v1"]);
    const closeBudget = vi.spyOn(one.services, "closeModelBudget"),
      closeAlerts = vi.spyOn(one.services, "closeAlertFacts");
    const disable = vi.spyOn(one.services, "disableModelBudget");
    const consumer = one.consumers[0]!;
    const original = vi.mocked(consumer.close).getMockImplementation()!;
    vi.spyOn(consumer, "close").mockImplementation(async (timeout) => {
      entered.release();
      await gate.promise;
      await original(timeout);
    });
    const stopping = one.runtime.stop();
    try {
      await entered.promise;
      expect(disable).toHaveBeenCalledOnce();
      expect(closeBudget).not.toHaveBeenCalled();
      expect(closeAlerts).not.toHaveBeenCalled();
      gate.release();
      await stopping;
      expect(closeBudget).toHaveBeenCalledOnce();
      expect(closeAlerts).toHaveBeenCalledOnce();
      expect(closeBudget.mock.invocationCallOrder[0]).toBeLessThan(
        closeAlerts.mock.invocationCallOrder[0]!,
      );
      expect(consumer.close).toHaveBeenCalledWith(SHUTDOWN_WAIT_MS);
      expect(one.runtime.stop()).toBe(stopping);
      await one.runtime.stop();
      expect(closeBudget).toHaveBeenCalledOnce();
      await one.services.scanPromote().catch(() => undefined);
      expect(one.evaluate).toHaveBeenCalledOnce();
      expect(one.channel.close).not.toHaveBeenCalled();
      expect(await prisma.$queryRaw`SELECT 1`).toHaveLength(1);
    } finally {
      gate.release();
      await stopping;
      vi.restoreAllMocks();
    }
  });

  it("stop先取消在途维护，迟到EVAL不重放；另一真实装配实例仍工作", async () => {
    const entered = deferred();
    let reject!: (error: unknown) => void;
    const evaluate = vi.fn<BudgetTransport["eval"]>(() => {
      entered.release();
      return new Promise((_r, no) => {
        reject = no;
      });
    });
    const first = instance(evaluate),
      second = instance();
    const scanning = first.services.scanPromote();
    try {
      await entered.promise;
      await first.runtime.stop();
      await scanning;
      reject(new Error("公开虚构迟到Redis故障"));
      await Promise.resolve();
      await second.services.scanPromote();
      expect(first.evaluate).toHaveBeenCalledOnce();
      expect(second.evaluate).toHaveBeenCalledOnce();
      expect(first.channel.close).not.toHaveBeenCalled();
      expect(second.channel.close).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([scanning, first.runtime.stop(), second.runtime.stop()]);
    }
  });

  it.each([
    "closeDocs",
    "closeStaff",
    "closeMediaDrivers",
    "closeStorageDrivers",
    "closeModelBudget",
  ] as const)("%s失败仍关闭本实例预算与告警，保留原异常", async (method) => {
    const one = instance(),
      original = one.services[method]!.bind(one.services),
      failure = new Error(`公开虚构${method}故障`);
    const budget = vi.spyOn(one.services, "closeModelBudget"),
      alerts = vi.spyOn(one.services, "closeAlertFacts");
    const broken = method === "closeModelBudget" ? budget : vi.spyOn(one.services, method);
    broken.mockImplementation(() => {
      throw failure;
    });
    try {
      await expect(one.runtime.stop()).rejects.toBe(failure);
      expect(budget).toHaveBeenCalledOnce();
      expect(alerts).toHaveBeenCalledOnce();
      expect(one.channel.close).not.toHaveBeenCalled();
      expect(await prisma.$queryRaw`SELECT 1`).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await original();
    }
  });

  it.each(["consumer", "shutdownMediaJobs", "closeNotify"] as const)(
    "%s失败不被预算close故障覆盖，全部资源继续收尾",
    async (where) => {
      const one = instance(),
        failure = new Error("公开虚构原业务失败");
      const originals = [
        one.services.shutdownMediaJobs!.bind(one.services),
        one.services.closeNotify.bind(one.services),
        one.services.closeModelBudget!.bind(one.services),
      ];
      if (where === "consumer") vi.spyOn(one.consumers[0]!, "close").mockRejectedValue(failure);
      else
        vi.spyOn(one.services, where).mockImplementation(() => {
          throw failure;
        });
      const budget = vi
        .spyOn(one.services, "closeModelBudget")
        .mockRejectedValue(new Error("公开虚构后续预算失败"));
      const alerts = vi.spyOn(one.services, "closeAlertFacts");
      try {
        await expect(one.runtime.stop()).rejects.toBe(failure);
        expect(budget).toHaveBeenCalledOnce();
        expect(alerts).toHaveBeenCalledOnce();
        for (const consumer of one.consumers)
          expect(consumer.close).toHaveBeenCalledWith(SHUTDOWN_WAIT_MS);
      } finally {
        vi.restoreAllMocks();
        for (const close of originals) await close();
      }
    },
  );
});
