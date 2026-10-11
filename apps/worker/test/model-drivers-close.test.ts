import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkerServices } from "@liyoxi/services";
import type { Env, QueueChannel, QueueConsumer, WorkerServicesOptions } from "@liyoxi/services";
import { assembleForTest, createFakeProviders, useSeededDatabase } from "@liyoxi/services/testing";
import { createWorkerRuntime, SHUTDOWN_WAIT_MS } from "../src/runtime.js";
import { silentLogger } from "../src/log.js";

const db = useSeededDatabase("worker", { max: 1, label: "modelsclose" });
const SLOW = 240000;
type Close = () => Promise<void>;
const keys: Pick<Env, "ASR_TENCENT" | "LLM_DOMESTIC"> = {
  ASR_TENCENT: { secretId: "public_fake_asr_id", secretKey: "public-fake-asr-secret" },
  LLM_DOMESTIC: {
    text: {
      primary: { vendor: "ark", model: "public-text", apiKey: "public-fake-text-key" },
      backup: { vendor: "deepseek", model: "public-backup", apiKey: "public-fake-backup-key" },
    },
    vision: {
      primary: { vendor: "ark", model: "public-vision", apiKey: "public-fake-vision-key" },
      backup: { vendor: "deepseek", model: "public-vision-b", apiKey: "public-fake-vision-b-key" },
    },
  },
};
let prisma: Awaited<ReturnType<typeof db.prisma>>;
beforeAll(async () => {
  prisma = await db.prisma();
}, SLOW);
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function instance(providers?: WorkerServicesOptions["providers"]) {
  const actualCloses: Close[] = [];
  const modelCloses: Array<ReturnType<typeof vi.fn<Close>>> = [];
  const registerClose = vi.fn((close: Close) => {
    actualCloses.push(close);
    modelCloses.push(vi.fn(close));
  });
  let closing: Promise<void> | undefined;
  const close = vi.fn(
    (): Promise<void> =>
      (closing ??= Promise.allSettled(
        modelCloses.map((finish) => Promise.resolve().then(finish)),
      ).then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })),
  );
  const consumers: QueueConsumer[] = [];
  // 真实运行时与服务装配；只替换队列IO。测试始终不start循环，不新增业务连接池。
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
    keys,
    modelDrivers: { registerClose, close },
    ...(providers ? { providers } : {}),
    logger: silentLogger,
  });
  const runtime = createWorkerRuntime({ services, channel, logger: silentLogger });
  const one = {
    services,
    runtime,
    channel,
    consumers,
    registerClose,
    close,
    actualCloses,
    modelCloses,
    recover: [] as Array<() => void | Promise<void>>,
  };
  instances.push(one);
  return one;
}
const instances: Array<{
  runtime: ReturnType<typeof createWorkerRuntime>;
  recover: Array<() => void | Promise<void>>;
}> = [];
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("关闭用例禁止模型HTTP"))),
  );
});
afterEach(async () => {
  for (const one of instances) await Promise.allSettled([one.runtime.stop()]);
  vi.restoreAllMocks();
  for (const one of instances) await Promise.allSettled(one.recover.map((close) => close()));
  instances.length = 0;
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
function finalCleanup(one: ReturnType<typeof instance>) {
  for (const consumer of one.consumers) {
    expect(consumer.close).toHaveBeenCalledExactlyOnceWith(SHUTDOWN_WAIT_MS);
    expect(consumer.start).not.toHaveBeenCalled();
  }
  expect(one.channel.close).not.toHaveBeenCalled();
}

describe("真实worker自有模型驱动关闭生命周期", { timeout: SLOW }, () => {
  it("真实工厂只登记两个实际模型close，构造无模型HTTP且重复stop复用Promise", async () => {
    const one = instance();
    expect(one.registerClose).toHaveBeenCalledTimes(2);
    expect(one.actualCloses).toHaveLength(2);
    expect(one.services.providers.asr.status).toBe("tencent");
    expect(one.services.providers.llm.status).toBe("domestic-llm");
    expect(one.modelCloses.every((close) => close.mock.calls.length === 0)).toBe(true);
    const stopping = one.runtime.stop();
    expect(one.runtime.stop()).toBe(stopping);
    await stopping;
    expect(one.close).toHaveBeenCalledOnce();
    for (const close of one.modelCloses) expect(close).toHaveBeenCalledOnce();
    const closing = one.services.closeModelDrivers!();
    expect(one.services.closeModelDrivers!()).toBe(closing);
    await closing;
    for (const close of one.modelCloses) expect(close).toHaveBeenCalledOnce();
    finalCleanup(one);
    expect(await prisma.$queryRaw`SELECT 1`).toHaveLength(1);
  });

  it("先禁用准入，依次收完media与consumer门闩，才关模型、预算、告警", async () => {
    const one = instance();
    const mediaEntered = deferred(),
      media = deferred();
    const queueEntered = deferred(),
      queue = deferred();
    const originalMedia = one.services.shutdownMediaJobs!.bind(one.services);
    const shutdown = vi.spyOn(one.services, "shutdownMediaJobs").mockImplementation(async () => {
      mediaEntered.release();
      await media.promise;
      await originalMedia();
    });
    const consumer = one.consumers[0]!;
    const originalQueue = vi.mocked(consumer.close).getMockImplementation()!;
    vi.spyOn(consumer, "close").mockImplementation(async (timeout) => {
      queueEntered.release();
      await queue.promise;
      await originalQueue(timeout);
    });
    const disable = vi.spyOn(one.services, "disableModelBudget");
    const budget = vi.spyOn(one.services, "closeModelBudget");
    const alerts = vi.spyOn(one.services, "closeAlertFacts");
    const stopping = one.runtime.stop();
    try {
      await mediaEntered.promise;
      expect(disable).toHaveBeenCalledOnce();
      expect(consumer.close).not.toHaveBeenCalled();
      expect(one.close).not.toHaveBeenCalled();
      media.release();
      await queueEntered.promise;
      expect(one.runtime.stop()).toBe(stopping);
      expect(one.close).not.toHaveBeenCalled();
      expect(budget).not.toHaveBeenCalled();
      expect(alerts).not.toHaveBeenCalled();
      queue.release();
      await stopping;
      expect(disable.mock.invocationCallOrder[0]).toBeLessThan(
        shutdown.mock.invocationCallOrder[0]!,
      );
      for (const close of one.modelCloses) {
        expect(close).toHaveBeenCalledOnce();
        expect(vi.mocked(consumer.close).mock.invocationCallOrder[0]).toBeLessThan(
          close.mock.invocationCallOrder[0]!,
        );
        expect(close.mock.invocationCallOrder[0]).toBeLessThan(budget.mock.invocationCallOrder[0]!);
      }
      expect(budget).toHaveBeenCalledOnce();
      expect(alerts).toHaveBeenCalledOnce();
      expect(budget.mock.invocationCallOrder[0]).toBeLessThan(alerts.mock.invocationCallOrder[0]!);
      finalCleanup(one);
    } finally {
      media.release();
      queue.release();
      await stopping;
    }
  });

  it("一个模型close拒绝仍等另一真实门闩，预算告警和原清理不被跳过", async () => {
    const one = instance(),
      entered = deferred(),
      gate = deferred();
    const failure = new Error("public-model-close-failure");
    one.modelCloses[0]!.mockImplementation(async () => {
      await one.actualCloses[0]!();
      throw failure;
    });
    one.modelCloses[1]!.mockImplementation(async () => {
      entered.release();
      await gate.promise;
      await one.actualCloses[1]!();
    });
    const budget = vi.spyOn(one.services, "closeModelBudget");
    const alerts = vi.spyOn(one.services, "closeAlertFacts");
    const docs = vi.spyOn(one.services, "closeDocs");
    const staff = vi.spyOn(one.services, "closeStaff");
    const stopping = one.runtime.stop();
    const result = stopping.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      expect(one.runtime.stop()).toBe(stopping);
      expect(docs).toHaveBeenCalledOnce();
      expect(staff).toHaveBeenCalledOnce();
      expect(budget).not.toHaveBeenCalled();
      expect(alerts).not.toHaveBeenCalled();
    } finally {
      gate.release();
    }
    expect(await result).toBe(failure);
    expect(budget).toHaveBeenCalledOnce();
    expect(alerts).toHaveBeenCalledOnce();
    for (const close of one.modelCloses) expect(close).toHaveBeenCalledOnce();
    finalCleanup(one);
    expect(await prisma.$queryRaw`SELECT 1`).toHaveLength(1);
  });

  it.each(["consumer", "shutdownMediaJobs", "closeNotify", "closeOrder"] as const)(
    "%s原故障不被后续模型close覆盖，全部模型预算告警仍关闭",
    async (where) => {
      const one = instance(),
        failure = new Error(`public-${where}-failure`);
      if (where === "consumer") vi.spyOn(one.consumers[0]!, "close").mockRejectedValue(failure);
      else {
        one.recover.push(one.services[where]!.bind(one.services));
        vi.spyOn(one.services, where).mockImplementation(() => {
          throw failure;
        });
      }
      one.modelCloses[0]!.mockImplementation(async () => {
        await one.actualCloses[0]!();
        throw new Error("public-later-model-close-failure");
      });
      const budget = vi.spyOn(one.services, "closeModelBudget");
      const alerts = vi.spyOn(one.services, "closeAlertFacts");
      await expect(one.runtime.stop()).rejects.toBe(failure);
      for (const close of one.modelCloses) expect(close).toHaveBeenCalledOnce();
      expect(budget).toHaveBeenCalledOnce();
      expect(alerts).toHaveBeenCalledOnce();
      finalCleanup(one);
    },
  );

  it("借用整套providers时不消费生命周期，配置存在也不关闭借用模型", async () => {
    const borrowed = createFakeProviders();
    const asrClose = vi.fn(),
      llmClose = vi.fn();
    Object.assign(borrowed.asr, { close: asrClose });
    Object.assign(borrowed.llm, { close: llmClose });
    const one = instance(borrowed);
    expect(one.services.providers).toBe(borrowed);
    expect(one.services.closeModelDrivers).toBeUndefined();
    await one.runtime.stop();
    expect(one.registerClose).not.toHaveBeenCalled();
    expect(one.close).not.toHaveBeenCalled();
    expect(asrClose).not.toHaveBeenCalled();
    expect(llmClose).not.toHaveBeenCalled();
    expect((await borrowed.llm.extractKeyPoints({ text: "公开虚构文字", maxPoints: 1 })).ok).toBe(
      true,
    );
    finalCleanup(one);
  });

  it("两个真实装配实例的模型列表、关闭Promise和预算清理相互隔离", async () => {
    const first = instance(),
      second = instance();
    const firstBudget = vi.spyOn(first.services, "closeModelBudget");
    const secondBudget = vi.spyOn(second.services, "closeModelBudget");
    const stopping = first.runtime.stop();
    await stopping;
    for (const close of first.modelCloses) expect(close).toHaveBeenCalledOnce();
    for (const close of second.modelCloses) expect(close).not.toHaveBeenCalled();
    expect(firstBudget).toHaveBeenCalledOnce();
    expect(secondBudget).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
    await second.runtime.stop();
    expect(first.services.closeModelDrivers!()).not.toBe(second.services.closeModelDrivers!());
    for (const close of second.modelCloses) expect(close).toHaveBeenCalledOnce();
    expect(secondBudget).toHaveBeenCalledOnce();
    finalCleanup(first);
    finalCleanup(second);
  });
});
