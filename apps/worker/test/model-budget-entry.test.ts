import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerServicesOptions } from "@liyoxi/services";

const ports = vi.hoisted(() => {
  const state = {
    clients: [] as Array<{
      status: string;
      options: Record<string, unknown>;
      connect: ReturnType<typeof vi.fn>;
      eval: ReturnType<typeof vi.fn>;
      quit: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }>,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    database: { prisma: {}, close: vi.fn(async () => undefined) },
    channel: { close: vi.fn(async () => undefined) },
    lease: { holder: "公开虚构worker", close: vi.fn(async () => undefined) },
    runtime: { start: vi.fn(), stop: vi.fn<() => Promise<void>>(async () => undefined) },
    build: vi.fn((_options: unknown): Record<string, unknown> => ({})),
    createRuntime: vi.fn((_options: unknown): unknown => ({})),
  };
  class Redis {
    status = "wait";
    connect = vi.fn(async () => {
      this.status = "connecting";
    });
    eval = vi.fn(async () => ["reserved", 3, 1]);
    quit = vi.fn(async () => "OK");
    disconnect = vi.fn(() => {
      this.status = "end";
    });
    on = vi.fn(() => this);
    constructor(
      _url: string,
      readonly options: Record<string, unknown>,
    ) {
      state.clients.push(this);
    }
  }
  return { ...state, Redis };
});
vi.mock("ioredis", () => ({ Redis: ports.Redis }));
vi.mock("@liyoxi/services", () => ({
  loadEnv: () => ({
    APP_ENV: "test",
    LOG_LEVEL: "error",
    REDIS_URL: "redis://public-fixture",
    DATABASE_URL: "postgresql://public-fixture",
  }),
  assembleServices: () => ({ modules: [], subscribers: [], timerHandlers: [] }),
  connectWorkerDatabase: () => ports.database,
  createQueueChannel: () => ports.channel,
  createWorkerLease: () => ports.lease,
  buildWorkerServices: ports.build,
  bullPrefix: () => "lyx:test:bull",
  setPortLogger: vi.fn(),
  EnvError: class EnvError extends Error {},
}));
vi.mock("../src/log.js", () => ({ createLogger: () => ports.logger }));
vi.mock("../src/recurring.js", () => ({ recurringTable: () => [] }));
vi.mock("../src/runtime.js", () => ({ createWorkerRuntime: ports.createRuntime }));
import { main } from "../src/index.js";

let services: Record<string, ReturnType<typeof vi.fn> | null>;
let signals: Map<string, () => void>;
let exit: ReturnType<typeof vi.fn<typeof process.exit>>;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  ports.clients.length = 0;
  services = { documentConverter: null };
  for (const name of [
    "selfCheck",
    "disableModelBudget",
    "shutdownMediaJobs",
    "closeDocs",
    "closeApproval",
    "closeInvitations",
    "closeMediaJobs",
    "closeMediaDrivers",
    "closeStorageDrivers",
    "closeModelBudget",
    "closeAlertFacts",
  ])
    services[name] = vi.fn(async () => undefined);
  ports.build.mockImplementation(() => services);
  ports.createRuntime.mockImplementation(() => ports.runtime);
  ports.runtime.start.mockReset();
  ports.runtime.stop.mockReset().mockResolvedValue(undefined);
  signals = new Map();
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    signals.set(String(event), listener as () => void);
    return process;
  });
  exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());
function budgetTransport() {
  return (
    ports.build.mock.calls[0]![0] as {
      modelBudgetTransport: NonNullable<WorkerServicesOptions["modelBudgetTransport"]>;
    }
  ).modelBudgetTransport;
}
async function stopped() {
  signals.get("SIGTERM")!();
  await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
}

describe("真实worker main入口，外部连接替身", () => {
  it("--check零预算客户端/零EVAL/零租约，仍真实走自检和清理分支", async () => {
    await main(["--check"]);
    expect(ports.clients).toHaveLength(0);
    expect(ports.build.mock.calls[0]![0]).not.toHaveProperty("modelBudgetTransport");
    expect(services.selfCheck).toHaveBeenCalledOnce();
    expect(services.closeModelBudget).toHaveBeenCalledOnce();
    expect(services.closeAlertFacts).toHaveBeenCalledOnce();
    expect(ports.database.close).toHaveBeenCalledOnce();
    expect(ports.createRuntime).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("--check关闭失败仍清全部绑定并保留失败，不伪报自检成功", async () => {
    const failure = new Error("公开虚构预算关闭失败");
    services.closeModelBudget!.mockRejectedValueOnce(failure);
    await expect(main(["--check"])).rejects.toBe(failure);
    expect(ports.clients).toHaveLength(0);
    expect(services.closeAlertFacts).toHaveBeenCalledOnce();
    expect(ports.database.close).toHaveBeenCalledOnce();
  });

  it("正常入口只构造专用lazy连接，不使用queue连接或重复keyPrefix", async () => {
    await main([]);
    expect(ports.clients).toHaveLength(1);
    const client = ports.clients[0]!;
    expect(client.options).toMatchObject({
      lazyConnect: true,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 250,
      commandTimeout: 250,
    });
    expect(client.options).not.toHaveProperty("keyPrefix");
    expect((client.options.retryStrategy as () => unknown)()).toBeNull();
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled();
    await expect(
      budgetTransport().eval("script", ["lyx:test:model_budget:v1"], ["1"]),
    ).rejects.toThrow("尚未就绪");
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.eval).not.toHaveBeenCalled();
    client.status = "ready";
    expect(await budgetTransport().eval("script", ["lyx:test:model_budget:v1"], ["1"])).toEqual([
      "reserved",
      3,
      1,
    ]);
    expect(client.eval).toHaveBeenCalledExactlyOnceWith(
      "script",
      1,
      "lyx:test:model_budget:v1",
      "1",
    );
    await stopped();
    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(ports.channel.close).toHaveBeenCalledOnce();
    expect(ports.lease.close).toHaveBeenCalledOnce();
  });

  it("信号先禁用许可，真实stop门闩未收完前不关闭自有Redis；重复信号幂等", async () => {
    let release!: () => void;
    ports.runtime.stop.mockImplementation(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    await main([]);
    const client = ports.clients[0]!;
    client.status = "ready";
    signals.get("SIGTERM")!();
    signals.get("SIGINT")!();
    try {
      await vi.waitFor(() => expect(ports.runtime.stop).toHaveBeenCalledOnce());
      expect(services.disableModelBudget).toHaveBeenCalledOnce();
      expect(client.quit).not.toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(client.quit).toHaveBeenCalledOnce();
      expect(ports.database.close).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });

  it.each(["build", "selfCheck", "runtime", "start"] as const)(
    "%s失败仍按顺序回收预算/告警/自有连接，原异常不变",
    async (where) => {
      const failure = new Error(`公开虚构${where}异常`);
      if (where === "build")
        ports.build.mockImplementationOnce(() => {
          throw failure;
        });
      if (where === "selfCheck") services.selfCheck!.mockRejectedValueOnce(failure);
      if (where === "runtime")
        ports.createRuntime.mockImplementationOnce(() => {
          throw failure;
        });
      if (where === "start")
        ports.runtime.start.mockImplementationOnce(() => {
          throw failure;
        });
      services.closeDocs!.mockRejectedValueOnce(new Error("公开虚构后续close故障"));
      await expect(main([])).rejects.toBe(failure);
      const client = ports.clients[0]!;
      expect(client.disconnect).toHaveBeenCalledOnce();
      expect(ports.channel.close).toHaveBeenCalledOnce();
      expect(ports.database.close).toHaveBeenCalledOnce();
      if (where !== "build") {
        expect(services.closeModelBudget).toHaveBeenCalledOnce();
        expect(services.closeAlertFacts).toHaveBeenCalledOnce();
        expect(services.closeModelBudget!.mock.invocationCallOrder[0]).toBeLessThan(
          client.disconnect.mock.invocationCallOrder[0]!,
        );
      }
      expect(exit).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "预算quit失败%s也disconnect并收其它资源；原stop失败保留",
    async (stopFails) => {
      const failure = new Error("公开虚构原stop失败");
      if (stopFails) ports.runtime.stop.mockRejectedValueOnce(failure);
      await main([]);
      const client = ports.clients[0]!;
      client.status = "ready";
      client.quit.mockRejectedValueOnce(new Error("公开虚构quit失败"));
      await stopped();
      expect(exit).toHaveBeenCalledWith(1);
      expect(client.disconnect).toHaveBeenCalledOnce();
      expect(ports.channel.close).toHaveBeenCalledOnce();
      expect(ports.lease.close).toHaveBeenCalledOnce();
      expect(ports.database.close).toHaveBeenCalledOnce();
      if (stopFails)
        expect(ports.logger.error).toHaveBeenCalledWith({ err: failure }, "任务关停失败");
    },
  );
});
