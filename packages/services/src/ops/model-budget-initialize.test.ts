import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClock } from "../testing/index.js";
import type { ModelBudgetTransport } from "../media/index.js";
import { createModelBudgetInitializer } from "./model-budget-initialize.js";

const cli = vi.hoisted(() => ({
  construct: vi.fn(),
  connect: vi.fn(async () => undefined),
  quit: vi.fn(async () => "OK"),
  disconnect: vi.fn(),
  load: vi.fn(() => ({ APP_ENV: "test", REDIS_URL: "redis://fictional.invalid" })),
  evaluate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("../kernel/index.js", async (original) => ({
  ...(await original<object>()),
  loadEnv: cli.load,
}));
vi.mock("./index.js", async () => await import("./model-budget-initialize.js"));
vi.mock("ioredis", () => ({
  Redis: class {
    status = "ready";
    constructor(...args: unknown[]) {
      cli.construct(...args);
    }
    on() {
      return this;
    }
    connect = cli.connect;
    quit = cli.quit;
    disconnect = cli.disconnect;
    eval(...args: unknown[]) {
      return cli.evaluate(...args);
    }
  },
}));
import { main } from "../../scripts/model-budget-initialize.js";

const signal = () => new AbortController().signal;
const writeReply = (at: number, duration: number) => {
  const day = Math.floor((at + 28800000) / 86400000),
    tomorrow = (day + 1) * 86400000 - 28800000;
  return ["initialized", day, tomorrow + duration + 5000, tomorrow];
};
beforeEach(() => {
  vi.clearAllMocks();
  cli.connect.mockResolvedValue(undefined);
  cli.quit.mockResolvedValue("OK");
  cli.evaluate.mockImplementation(async (script, _count, _key, at, duration) =>
    String(script).includes("redis.call('HSET'")
      ? writeReply(Number(at), Number(duration))
      : ["missing"],
  );
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("显式保守建账纯协议与CLI", () => {
  it("导入/check与非法目标零IO；显式CLI固定key、原连接边界和异常收尾", async () => {
    expect(cli.construct).not.toHaveBeenCalled();
    expect(await main(["--check"])).toBe(0);
    for (const args of [
      [],
      ["--check", "--initialize"],
      ["--initialize", "key"],
      ["--key=x"],
      ["--prefix=x"],
      ["--cap=1"],
      ["--eval=x"],
    ])
      expect(await main(args)).toBe(2);
    expect(cli.load).not.toHaveBeenCalled();
    expect(cli.construct).not.toHaveBeenCalled();
    const clock = createClock(new Date());
    for (const change of [{ prefix: "lyx:test:other:" }, { key: "other" }, { appEnv: "alien" }])
      expect(() =>
        Reflect.apply(createModelBudgetInitializer, undefined, [
          { appEnv: "test", clock, ...change },
        ]),
      ).toThrow(TypeError);
    const absent = createModelBudgetInitializer({ appEnv: "test", clock });
    expect(await absent.initialize(signal())).toEqual({ status: "unavailable" });
    await absent.close();
    expect(await main(["--initialize"])).toBe(0);
    expect(cli.construct.mock.calls[0]![1]).toMatchObject({
      lazyConnect: true,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
      commandTimeout: 250,
    });
    expect(cli.evaluate).toHaveBeenCalledTimes(2);
    for (const [, count, key] of cli.evaluate.mock.calls) {
      expect(count).toBe(1);
      expect(key).toBe("lyx:test:model_budget:v1");
    }
    expect(cli.quit).toHaveBeenCalledOnce();
    expect(cli.disconnect).toHaveBeenCalledOnce();
    cli.connect.mockRejectedValueOnce(new Error("PRIVATE_REDIS_URL"));
    expect(await main(["--initialize"])).toBe(1);
    expect(cli.evaluate).toHaveBeenCalledTimes(2);
    expect(cli.disconnect).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toContain(
      "PRIVATE_REDIS_URL",
    );
  });

  it("取消/整体250ms超时丢弃迟到写结果且不重发，close成对且不关闭借用传输", async () => {
    vi.useFakeTimers();
    for (const mode of ["timeout", "cancel", "close"] as const) {
      const clock = createClock(new Date()),
        controller = new AbortController();
      let release!: (value: unknown) => void, enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const evaluate = vi.fn<ModelBudgetTransport["eval"]>(async (script) => {
        if (!script.includes("redis.call('HSET'")) return ["missing"];
        enter();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const initializer = createModelBudgetInitializer({
        appEnv: "test",
        clock,
        transport: { eval: evaluate },
      });
      expect(evaluate).not.toHaveBeenCalled();
      const running = initializer.initialize(controller.signal);
      await entered;
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(250);
      if (mode === "cancel") controller.abort();
      if (mode === "close") await initializer.close();
      expect(await running).toEqual({ status: "unavailable" });
      release(writeReply(clock.now().getTime(), 1800000));
      await Promise.resolve();
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(initializer.close()).toBe(initializer.close());
      await initializer.close();
      expect(await initializer.initialize(signal())).toEqual({ status: "unavailable" });
      expect(evaluate).toHaveBeenCalledTimes(2);
    }
  });
});
