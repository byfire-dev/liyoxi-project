import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RuntimeOptions } from "@liyoxi/services";

const ports = vi.hoisted(() => {
  const logger = { info: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return {
    logger,
    env: vi.fn<() => Env>(),
    runtime: { logger, startupChecks: [], close: vi.fn<() => Promise<void>>() },
    create: vi.fn((_options: RuntimeOptions): unknown => ({})),
    checks: vi.fn<(_checks: unknown) => Promise<void>>(),
    app: {
      app: { fetch: vi.fn() },
      readiness: { state: "starting" as "starting" | "ready" | "draining" },
      mounted: [],
    },
    createApp: vi.fn((_options: unknown): unknown => ({})),
    server: { close: vi.fn<(_finish: () => void) => void>() },
    serve: vi.fn((_options: unknown, _ready: (address: { port: number }) => void): unknown => ({})),
    asrClose: vi.fn<() => Promise<void>>(),
    otherClose: vi.fn<() => Promise<void>>(),
    drained: [] as Array<() => void>,
    listening: [] as Array<(address: { port: number }) => void>,
  };
});
vi.mock("@liyoxi/services", () => ({
  loadEnv: ports.env,
  createRuntime: ports.create,
  runStartupChecks: ports.checks,
}));
vi.mock("@hono/node-server", () => ({ serve: ports.serve }));
vi.mock("../src/app.js", () => ({ createApp: ports.createApp }));
vi.mock("../src/routes/index.js", () => ({ HANDLERS: [] }));
vi.mock("../src/version.js", () => ({ VERSION: "public-fixture-version" }));
const originalArgv = process.argv;
const asr = { secretId: "public_fake_asr_id", secretKey: "public-fake-asr-secret" };
let signals: Map<string, () => void>;
let exit: ReturnType<typeof vi.fn<typeof process.exit>>;
function argv(...args: string[]) {
  process.argv = [process.execPath, "/public-fixture/import-not-server.js", ...args];
}
function lifecycle() {
  return ports.create.mock.calls.at(-1)![0].modelDrivers!;
}
async function main() {
  const entry = await import("../src/server.js");
  await entry.main();
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function stopped() {
  signals.get("SIGTERM")!();
  ports.drained.shift()!();
  await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.resetModules();
  argv();
  ports.drained.length = 0;
  ports.listening.length = 0;
  ports.app.readiness.state = "starting";
  ports.env.mockReturnValue({
    APP_ENV: "test",
    LOG_LEVEL: "error",
    DATABASE_URL: "postgresql://public-fixture",
    REDIS_URL: "redis://public-fixture",
    ASR_TENCENT: asr,
  });
  ports.asrClose.mockResolvedValue(undefined);
  ports.otherClose.mockResolvedValue(undefined);
  ports.checks.mockResolvedValue(undefined);
  ports.create.mockImplementation((options) => {
    if (options.env.ASR_TENCENT) options.modelDrivers!.registerClose(ports.asrClose);
    return ports.runtime;
  });
  ports.runtime.close.mockImplementation(async () => {
    await lifecycle().close();
  });
  ports.createApp.mockReturnValue(ports.app);
  ports.serve.mockImplementation((_options, ready) => {
    ports.listening.push(ready);
    return ports.server;
  });
  ports.server.close.mockImplementation((finish) => {
    ports.drained.push(finish);
  });
  signals = new Map();
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    signals.set(String(event), listener as () => void);
    return process;
  });
  exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("入口夹具禁止模型HTTP"))),
  );
});
afterEach(() => {
  process.argv = originalArgv;
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API ASR模型所有权的真实server入口", () => {
  it("仅导入入口不解析CLI、不读Env、不构造运行时也不监听", async () => {
    argv("--port", "invalid");
    const entry = await import("../src/server.js");
    expect(entry.main).toBeTypeOf("function");
    expect(ports.env).not.toHaveBeenCalled();
    expect(ports.create).not.toHaveBeenCalled();
    expect(ports.serve).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(signals.size).toBe(0);
  });

  it.each([false, true])("ASR配置%s透传原Env，默认CLI与就绪/排空状态保持", async (configured) => {
    const env = ports.env.mock.results[0]?.value as Env | undefined;
    const selected = env ?? {
      APP_ENV: "test" as const,
      LOG_LEVEL: "error" as const,
      DATABASE_URL: "postgresql://public-fixture",
      REDIS_URL: "redis://public-fixture",
    };
    ports.env.mockReturnValue({ ...selected, ...(configured ? { ASR_TENCENT: asr } : {}) });
    await main();
    expect(ports.create.mock.calls[0]![0].env).toBe(ports.env.mock.results[0]!.value);
    expect(ports.create.mock.calls[0]![0]).toMatchObject({
      entry: "api",
      version: "public-fixture-version",
    });
    expect(lifecycle()).toEqual({
      registerClose: expect.any(Function),
      close: expect.any(Function),
    });
    expect(ports.serve.mock.calls[0]![0]).toEqual({
      fetch: ports.app.app.fetch,
      port: 3000,
      hostname: "0.0.0.0",
    });
    expect(ports.app.readiness.state).toBe("starting");
    ports.listening[0]!({ port: 4321 });
    expect(ports.app.readiness.state).toBe("ready");
    await stopped();
    expect(ports.app.readiness.state).toBe("draining");
    expect(ports.runtime.close).toHaveBeenCalledOnce();
    expect(ports.asrClose).toHaveBeenCalledTimes(configured ? 1 : 0);
  });

  it("显式端口主机和可信代理参数沿原CLI传递", async () => {
    argv(
      "--port",
      "0",
      "--host",
      "127.0.0.1",
      "--trusted-proxy-hops",
      "2",
      "--trusted-proxy-cidrs",
      "10.0.0.0/8,,192.168.0.0/16",
    );
    await main();
    expect(ports.serve.mock.calls[0]![0]).toMatchObject({ port: 0, hostname: "127.0.0.1" });
    expect(ports.createApp.mock.calls[0]![0]).toMatchObject({
      trustedProxy: {
        hops: 2,
        cidrs: ["10.0.0.0/8", "192.168.0.0/16"],
      },
    });
    await stopped();
  });

  it.each(["-1", "65536", "1.5", "NaN"])("非法端口%s在Env与DI前按原CLI退出1", async (port) => {
    argv("--port", port);
    const exited = new Error("public-process-exit");
    exit.mockImplementationOnce(() => {
      throw exited;
    });
    await expect(main()).rejects.toBe(exited);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(console.error).toHaveBeenCalledWith("--port 要是 0 到 65535 之间的整数");
    expect(ports.env).not.toHaveBeenCalled();
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("未知CLI选项沿parseArgs拒绝，不提前读配置", async () => {
    argv("--public-unknown-option");
    await expect(main()).rejects.toThrow("Unknown option");
    expect(ports.env).not.toHaveBeenCalled();
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("SIG先等待HTTP排空再收runtime，模型关闭共享缓存Promise且重复信号幂等", async () => {
    const entered = deferred(),
      drain = deferred();
    const original = ports.runtime.close.getMockImplementation()!;
    let first: Promise<void> | undefined;
    ports.runtime.close.mockImplementation(async () => {
      entered.release();
      await drain.promise;
      first = lifecycle().close();
      expect(lifecycle().close()).toBe(first);
      await original();
    });
    await main();
    signals.get("SIGTERM")!();
    signals.get("SIGINT")!();
    expect(ports.server.close).toHaveBeenCalledOnce();
    expect(ports.app.readiness.state).toBe("draining");
    expect(ports.runtime.close).not.toHaveBeenCalled();
    expect(ports.asrClose).not.toHaveBeenCalled();
    ports.drained.shift()!();
    await entered.promise;
    try {
      expect(ports.asrClose).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      drain.release();
    }
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(lifecycle().close()).toBe(first);
    expect(ports.asrClose).toHaveBeenCalledOnce();
    expect(ports.runtime.close).toHaveBeenCalledOnce();
  });

  it.each(["create", "app", "selfCheck", "serve"] as const)(
    "%s启动失败清理已登记ASR，关闭异常不替代原启动诊断与退出1",
    async (where) => {
      const failure = new Error(`public-${where}-failure`);
      ports.asrClose.mockRejectedValueOnce(new Error("public-later-close-failure"));
      if (where === "create")
        ports.create.mockImplementationOnce((options) => {
          options.modelDrivers!.registerClose(ports.asrClose);
          throw failure;
        });
      if (where === "app")
        ports.createApp.mockImplementationOnce(() => {
          throw failure;
        });
      if (where === "selfCheck") ports.checks.mockRejectedValueOnce(failure);
      if (where === "serve")
        ports.serve.mockImplementationOnce(() => {
          throw failure;
        });
      await main();
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(ports.asrClose).toHaveBeenCalledOnce();
      expect(ports.runtime.close).toHaveBeenCalledTimes(where === "create" ? 0 : 1);
      if (where === "create")
        expect(console.error).toHaveBeenCalledWith(`api 启动失败：${failure.message}`);
      else
        expect(ports.logger.fatal).toHaveBeenCalledWith(
          { evt: "api.start_failed" },
          failure.message,
        );
      expect(signals.size).toBe(0);
    },
  );

  it("Env失败在运行时创建之前退出1", async () => {
    ports.env.mockImplementationOnce(() => {
      throw new Error("ASR_TENCENT_FILE: 公开虚构校验失败");
    });
    await main();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(ports.create).not.toHaveBeenCalled();
    expect(ports.serve).not.toHaveBeenCalled();
    expect(ports.asrClose).not.toHaveBeenCalled();
  });

  it("部分创建登记多个close，一方失败仍等待另一门闩且只关闭一次", async () => {
    const entered = deferred(),
      pending = deferred();
    const failure = new Error("public-partial-create-failure");
    ports.asrClose.mockRejectedValueOnce(new Error("public-close-failure"));
    ports.otherClose.mockImplementationOnce(async () => {
      entered.release();
      await pending.promise;
    });
    ports.create.mockImplementationOnce((options) => {
      options.modelDrivers!.registerClose(ports.asrClose);
      options.modelDrivers!.registerClose(ports.otherClose);
      throw failure;
    });
    const starting = main();
    await entered.promise;
    const closing = lifecycle().close();
    expect(lifecycle().close()).toBe(closing);
    try {
      expect(ports.asrClose).toHaveBeenCalledOnce();
      expect(ports.otherClose).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      pending.release();
    }
    await starting;
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(console.error).toHaveBeenCalledWith(`api 启动失败：${failure.message}`);
    expect(ports.asrClose).toHaveBeenCalledOnce();
    expect(ports.otherClose).toHaveBeenCalledOnce();
  });

  it.each(["runtime", "model"] as const)(
    "正常stop的%s关闭失败仍兜底并按原语义退出0",
    async (where) => {
      const failure = new Error(`public-${where}-close-failure`);
      if (where === "runtime") ports.runtime.close.mockRejectedValueOnce(failure);
      else ports.asrClose.mockRejectedValueOnce(failure);
      await main();
      await stopped();
      expect(ports.runtime.close).toHaveBeenCalledOnce();
      expect(ports.asrClose).toHaveBeenCalledOnce();
      expect(ports.logger.error).toHaveBeenCalledWith(
        { evt: "api.close", err: failure },
        "断开连接出错",
      );
      expect(ports.logger.info).toHaveBeenCalledWith({ evt: "api.stopped" }, "api 已退出");
    },
  );
});
