import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RuntimeOptions } from "@liyoxi/services";

const ports = vi.hoisted(() => ({
  order: [] as string[],
  env: vi.fn<() => Env>(),
  create: vi.fn<(_options: RuntimeOptions) => unknown>(),
  budget: { transport: { eval: vi.fn() }, close: vi.fn<() => Promise<void>>() },
  budgetFactory: vi.fn<(_input: unknown) => unknown>(),
  runtime: {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
    startupChecks: [],
    close: vi.fn<() => Promise<void>>(),
  },
  modelClose: vi.fn<() => Promise<void>>(),
  checks: vi.fn<() => Promise<void>>(),
  app: { app: { fetch: vi.fn() }, mounted: [], readiness: { state: "starting" } },
  drained: [] as Array<() => void>,
  server: { close: vi.fn<(_done: () => void) => void>() },
  serve: vi.fn<(_options: unknown, _ready: unknown) => unknown>(),
}));
vi.mock("@liyoxi/services", () => ({
  loadEnv: ports.env,
  createRuntime: ports.create,
  runStartupChecks: ports.checks,
}));
vi.mock("@hono/node-server", () => ({ serve: ports.serve }));
vi.mock("../src/model-budget.js", () => ({ createApiModelBudgetTransport: ports.budgetFactory }));
vi.mock("../src/app.js", () => ({ createApp: () => ports.app }));
vi.mock("../src/routes/index.js", () => ({ HANDLERS: [] }));
vi.mock("../src/version.js", () => ({ VERSION: "public-model-entry" }));
const originalArgv = process.argv;
let signals: Map<string, () => void>, exit: ReturnType<typeof vi.fn<typeof process.exit>>;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.resetModules();
  process.argv = [
    process.execPath,
    "/public-fixture/not-server.js",
    "--test-redis-prefix",
    "lyx:test:entry:",
  ];
  ports.order.length = 0;
  ports.drained.length = 0;
  ports.app.readiness.state = "starting";
  ports.env.mockReturnValue({
    APP_ENV: "test",
    LOG_LEVEL: "error",
    DATABASE_URL: "postgresql://public.invalid",
    REDIS_URL: "redis://public.invalid",
    LLM_DOMESTIC: {
      text: {
        primary: { vendor: "deepseek", model: "public", apiKey: "PUBLIC" },
        backup: { vendor: "ark", model: "public", apiKey: "PUBLIC" },
      },
      vision: {
        primary: { vendor: "ark", model: "public", apiKey: "PUBLIC" },
        backup: { vendor: "deepseek", model: "public", apiKey: "PUBLIC" },
      },
    },
  });
  ports.budgetFactory.mockReturnValue(ports.budget);
  ports.modelClose.mockImplementation(async () => {
    ports.order.push("model");
  });
  ports.budget.close.mockImplementation(async () => {
    ports.order.push("budget");
  });
  ports.runtime.close.mockImplementation(async () => {
    ports.order.push("runtime");
    await ports.create.mock.calls.at(-1)![0].modelDrivers!.close();
  });
  ports.create.mockImplementation((options) => {
    options.modelDrivers!.registerClose(ports.modelClose);
    return ports.runtime;
  });
  ports.checks.mockResolvedValue(undefined);
  ports.serve.mockReturnValue(ports.server);
  ports.server.close.mockImplementation((done) => {
    ports.drained.push(done);
  });
  signals = new Map();
  vi.spyOn(process, "on").mockImplementation((name, handler) => {
    signals.set(String(name), handler as () => void);
    return process;
  });
  exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});
async function main() {
  const { main } = await import("../src/server.js");
  await main();
}
describe("API预算连接真实server入口所有权", () => {
  it("LLM-only入口透传实际transport和test隔离；HTTP排空后runtime/model/预算依序关闭，重复信号不重关", async () => {
    await main();
    expect(ports.budgetFactory).toHaveBeenCalledExactlyOnceWith({
      redisUrl: "redis://public.invalid",
      appEnv: "test",
      testKeyPrefix: "lyx:test:entry:",
      onError: expect.any(Function),
    });
    expect(ports.create.mock.calls[0]![0].modelBudgetTransport).toBe(ports.budget.transport);
    expect(ports.create.mock.calls[0]![0].env).toBe(ports.env.mock.results[0]!.value);
    signals.get("SIGTERM")!();
    signals.get("SIGINT")!();
    expect(ports.server.close).toHaveBeenCalledOnce();
    expect(ports.order).toEqual([]);
    ports.drained.shift()!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(ports.order).toEqual(["runtime", "model", "budget"]);
    expect(ports.modelClose).toHaveBeenCalledOnce();
    expect(ports.budget.close).toHaveBeenCalledOnce();
  });
  it("部分runtime构造失败仍收已登记模型与预算；模型close异常不跳过预算或替代原诊断", async () => {
    const failure = new Error("public-partial-create");
    ports.create.mockImplementationOnce((options) => {
      options.modelDrivers!.registerClose(ports.modelClose);
      throw failure;
    });
    ports.modelClose.mockImplementationOnce(async () => {
      ports.order.push("model");
      throw new Error("public-close-failed");
    });
    await main();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(ports.runtime.close).not.toHaveBeenCalled();
    expect(ports.order).toEqual(["model", "budget"]);
    expect(ports.budget.close).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith("api 启动失败：public-partial-create");
    expect(ports.serve).not.toHaveBeenCalled();
  });
});
