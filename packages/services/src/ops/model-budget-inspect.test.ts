import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { AppEnv } from "../kernel/index.js";
import { createClock } from "../testing/index.js";
import { createModelBudgetInspector } from "./model-budget-inspect.js";

const cli = vi.hoisted(() => ({
  construct: vi.fn(),
  connect: vi.fn(async () => undefined),
  quit: vi.fn(async () => "OK"),
  disconnect: vi.fn(),
  evaluate: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ["missing"]),
  load: vi.fn(() => ({ APP_ENV: "test", REDIS_URL: "redis://public-fixture.invalid" })),
}));
vi.mock("../kernel/index.js", async (original) => ({
  ...(await original<object>()),
  loadEnv: cli.load,
}));
vi.mock("./index.js", async () => await import("./model-budget-inspect.js"));
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
import { main } from "../../scripts/model-budget-inspect.js";

const day = (n: number) => Math.floor((n + 28800000) / 86400000);
const signal = () => new AbortController().signal;
const raw = (n: number): unknown[] => [
  "hash",
  8,
  n,
  n - 1,
  n - 1,
  day(n),
  0,
  1,
  1,
  1,
  0,
  0,
  0,
  0,
  0,
  0,
  -1,
  -1,
  -1,
];
function setup(reply?: unknown, appEnv: AppEnv = "test") {
  const clock = createClock(new Date()),
    evaluate = vi.fn<() => Promise<unknown>>(async () => reply ?? raw(clock.now().getTime()));
  const inspector = createModelBudgetInspector({ appEnv, clock, transport: { eval: evaluate } });
  return { clock, evaluate, inspector };
}
function gate() {
  let enter!: () => void, resolve!: (v: unknown) => void, reject!: (v: unknown) => void;
  const entered = new Promise<void>((yes) => {
    enter = yes;
  });
  const waiting = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {
    entered,
    resolve,
    reject,
    work: () => {
      enter();
      return waiting;
    },
  };
}
let output: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  cli.connect.mockResolvedValue(undefined);
  cli.quit.mockResolvedValue("OK");
  cli.evaluate.mockResolvedValue(["missing"]);
  cli.load.mockReturnValue({ APP_ENV: "test", REDIS_URL: "redis://public-fixture.invalid" });
  output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("只读预算诊断协议", () => {
  it.each(["local", "test", "stg", "prod"] as const)(
    "%s只使用accepted正式key，构造和借用close零传输",
    async (appEnv) => {
      const h = setup(undefined, appEnv);
      expect(h.evaluate).not.toHaveBeenCalled();
      expect((await h.inspector.inspect(signal())).status).toBe("inspected");
      expect(h.evaluate).toHaveBeenCalledOnce();
      const call = h.evaluate.mock.calls[0] as unknown as [string, string[], string[]];
      expect(call[1]).toEqual([`lyx:${appEnv}:model_budget:v1`]);
      expect(call[2]).toEqual([String(h.clock.now().getTime())]);
      expect([...call[0].matchAll(/redis\.call\('([^']+)'/g)].map((m) => m[1]).sort()).toEqual(
        ["HGET", "HGET", "HGET", "HLEN", "HMGET", "TIME", "TYPE"].sort(),
      );
      expect(call[0]).not.toMatch(
        /HSET|HDEL|UNLINK|SCRIPT|HSCAN|HGETALL|KEYS\s|redis\.call\('SCAN'/,
      );
      expect(h.inspector.close()).toBe(h.inspector.close());
      await h.inspector.close();
      expect(await h.inspector.inspect(signal())).toEqual({ status: "unavailable" });
      expect(h.evaluate).toHaveBeenCalledOnce();
    },
  );
  it.each(["other", "TEST", "test:escape", "", null] as const)(
    "非法AppEnv %s在构造时拒绝",
    (appEnv) => {
      expect(() =>
        createModelBudgetInspector({ appEnv: appEnv as AppEnv, clock: createClock() }),
      ).toThrow(TypeError);
    },
  );
  it.each(["prefix", "key", "url", "day"])("额外%s不能覆盖目标", (key) => {
    expect(() =>
      createModelBudgetInspector({
        appEnv: "test",
        clock: createClock(),
        [key]: "public-fixture",
      } as never),
    ).toThrow(TypeError);
  });
  it.each(["missing", "wrong_type"])("%s只报告观察事实，不授权或初始化", async (key) => {
    const h = setup([key]);
    expect(await h.inspector.inspect(signal())).toEqual({ status: "inspected", key });
    expect(h.evaluate).toHaveBeenCalledOnce();
    await h.inspector.close();
  });
  it.each([
    ["invalid_metadata", "metadata"],
    ["invalid_metadata", "field_bound"],
    ["invalid_metadata", "current_counter"],
    ["invalid_sample", "index"],
    ["invalid_sample", "target"],
  ])("%s/%s只输出受控reason", async (schema, reason) => {
    const h = setup(["hash", schema, reason]);
    expect(await h.inspector.inspect(signal())).toEqual({
      status: "inspected",
      key: "hash",
      schema,
      reason,
    });
    await h.inspector.close();
  });
  it.each([
    ["null", null],
    ["object", { marker: "public-private-marker" }],
    ["unknown", ["ready"]],
    ["extra", ["missing", 1]],
    ["badreason", ["hash", "invalid_sample", "public-private-marker"]],
    ["prototype", ["hash", "toString", "target"]],
    ["short", ["hash", 8]],
  ])("未知回复%s明确unavailable且不泄露原值", async (_label, reply) => {
    const h = setup(reply);
    if (reply === null) h.evaluate.mockResolvedValue(null);
    expect(await h.inspector.inspect(signal())).toEqual({ status: "unavailable" });
    await h.inspector.close();
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])(
    "数值位置%s拒绝非整数",
    async (index) => {
      const h = setup(),
        reply = raw(h.clock.now().getTime());
      reply[index] = "123";
      h.evaluate.mockResolvedValue(reply);
      expect(await h.inspector.inspect(signal())).toEqual({ status: "unavailable" });
      await h.inspector.close();
    },
  );
  it("完整受控facet不把closedBefore或完整样本称为open/业务许可", async () => {
    const h = setup(),
      now = h.clock.now().getTime(),
      reply = raw(now);
    reply[6] = now + 1000;
    h.evaluate.mockResolvedValue(reply);
    const result = await h.inspector.inspect(signal());
    expect(result).toMatchObject({
      status: "inspected",
      key: "hash",
      schema: "sampled_metadata_ok",
      closedBeforeMs: now + 1000,
      coverage: { kind: "sampled", slotsRead: 0, holes: 0, totalSlots: 0, hasMore: false },
      currentGlobalUsed: null,
      sampledReservations: {
        beforeDeadline: 0,
        retentionWindow: 0,
        expired: 0,
        boundaryDisagreement: 0,
        earliestDeadlineMs: null,
        latestDeadlineMs: null,
      },
    });
    expect(result).not.toHaveProperty("open");
    expect(result).not.toHaveProperty("allow");
    await h.inspector.close();
  });
  it.each(["sample-count", "counter-count"])("%s自相矛盾的回复明确不可用", async (fault) => {
    const h = setup(),
      reply = raw(h.clock.now().getTime());
    if (fault === "sample-count") {
      reply[8] = 2;
      reply[10] = 1;
    } else reply[18] = 3;
    h.evaluate.mockResolvedValue(reply);
    expect(await h.inspector.inspect(signal())).toEqual({ status: "unavailable" });
    await h.inspector.close();
  });
  it.each(["rollback", "dayMismatch", "skewExceeded", "rolloverPending"])(
    "时钟%s是独立诊断facet",
    async (facet) => {
      const h = setup(),
        now = h.clock.now().getTime(),
        reply = raw(now);
      if (facet === "rollback") reply[3] = now + 1;
      if (facet === "dayMismatch") reply[2] = now - 86400000;
      if (facet === "skewExceeded") reply[2] = now - 5001;
      if (facet === "rolloverPending") reply[5] = day(now) - 1;
      h.evaluate.mockResolvedValue(reply);
      expect(await h.inspector.inspect(signal())).toMatchObject({ clock: { [facet]: true } });
      await h.inspector.close();
    },
  );
  it.each([-1, 250, NaN])("返回后业务Clock偏移%s拒绝迟到或倒退结果", async (offset) => {
    const h = setup(),
      now = h.clock.now().getTime();
    h.evaluate.mockImplementation(async () => {
      h.clock.set(new Date(now + offset));
      return ["missing"];
    });
    expect(await h.inspector.inspect(signal())).toEqual({ status: "unavailable" });
    await h.inspector.close();
  });
  it("缺传输或预取消零EVAL", async () => {
    const clock = createClock(),
      h = setup(),
      cancel = new AbortController();
    cancel.abort();
    expect(await createModelBudgetInspector({ appEnv: "test", clock }).inspect(signal())).toEqual({
      status: "unavailable",
    });
    expect(await h.inspector.inspect(cancel.signal)).toEqual({ status: "unavailable" });
    expect(h.evaluate).not.toHaveBeenCalled();
    await h.inspector.close();
  });
  it.each(["resolve", "reject"])("close取消在途并消费迟到%s，不关闭借用transport", async (late) => {
    const h = setup(),
      g = gate();
    h.evaluate.mockImplementation(g.work);
    const running = h.inspector.inspect(signal());
    await g.entered;
    await h.inspector.close();
    expect(await running).toEqual({ status: "unavailable" });
    if (late === "resolve") g.resolve(["missing"]);
    else g.reject(new Error("public-private-marker"));
    await Promise.resolve();
    expect(h.evaluate).toHaveBeenCalledOnce();
  });
  it("原250ms界限取消不合作传输，迟到拒绝被消费", async () => {
    vi.useFakeTimers();
    const h = setup(),
      g = gate();
    h.evaluate.mockImplementation(g.work);
    const running = h.inspector.inspect(signal());
    await g.entered;
    await vi.advanceTimersByTimeAsync(250);
    expect(await running).toEqual({ status: "unavailable" });
    g.reject(new Error("public-private-marker"));
    await Promise.resolve();
    await h.inspector.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("外部取消和传输异常均关闭", async () => {
    const h = setup(),
      g = gate(),
      cancel = new AbortController();
    h.evaluate.mockImplementation(g.work);
    const running = h.inspector.inspect(cancel.signal);
    await g.entered;
    cancel.abort();
    expect(await running).toEqual({ status: "unavailable" });
    g.resolve(["missing"]);
    h.evaluate.mockRejectedValue(new Error("public-private-marker"));
    expect(await h.inspector.inspect(signal())).toEqual({ status: "unavailable" });
    await h.inspector.close();
  });
});

describe("真实inspect CLI入口（连接协议替身）", () => {
  it("实际entry守卫执行check并设置退出码，导入仍无环境IO", async () => {
    const argv = process.argv,
      code = process.exitCode;
    try {
      process.argv = [
        argv[0]!,
        fileURLToPath(new URL("../../scripts/model-budget-inspect.ts", import.meta.url)),
        "--check",
      ];
      process.exitCode = undefined;
      vi.resetModules();
      await import("../../scripts/model-budget-inspect.js");
      expect(process.exitCode).toBe(0);
      expect(cli.load).not.toHaveBeenCalled();
      expect(cli.construct).not.toHaveBeenCalled();
    } finally {
      process.argv = argv;
      process.exitCode = code;
    }
  });
  it("导入以及check不loadEnv/不构造连接/无输出", async () => {
    expect(cli.construct).not.toHaveBeenCalled();
    expect(cli.load).not.toHaveBeenCalled();
    expect(await main(["--check"])).toBe(0);
    expect(cli.load).not.toHaveBeenCalled();
    expect(cli.construct).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });
  it.each([
    ["default", []],
    ["both", ["--check", "--inspect"]],
    ["position", ["anything"]],
    ["url", ["--inspect", "--url", "redis://invalid"]],
    ["prefix", ["--inspect", "--prefix", "lyx:test:escape:"]],
    ["key", ["--inspect", "--key", "anything"]],
    ["day", ["--inspect", "--day", "1"]],
    ["restore", ["--restore"]],
  ] as const)("%s模式拒绝且零IO", async (_label, args) => {
    expect(await main(args)).toBe(2);
    expect(cli.load).not.toHaveBeenCalled();
    expect(cli.construct).not.toHaveBeenCalled();
  });
  it.each(["local", "test", "stg", "prod"])(
    "%s经正式环境到唯一key，连接始终独立关闭",
    async (appEnv) => {
      cli.load.mockReturnValue({ APP_ENV: appEnv, REDIS_URL: "redis://public-fixture.invalid" });
      expect(await main(["--inspect"])).toBe(0);
      expect(cli.load).toHaveBeenCalledOnce();
      expect(cli.construct).toHaveBeenCalledOnce();
      expect(cli.construct.mock.calls[0]?.[1]).toMatchObject({
        lazyConnect: true,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        maxRetriesPerRequest: 0,
        connectTimeout: 250,
        commandTimeout: 250,
      });
      expect(cli.evaluate.mock.calls[0]?.slice(1)).toEqual([
        1,
        `lyx:${appEnv}:model_budget:v1`,
        expect.any(String),
      ]);
      expect(cli.quit).toHaveBeenCalledOnce();
      expect(cli.disconnect).toHaveBeenCalledOnce();
      expect(output).toHaveBeenCalledWith('{"status":"inspected","key":"missing"}\n');
      expect(JSON.stringify(output.mock.calls)).not.toContain("redis://public-fixture.invalid");
    },
  );
  it.each(["env", "connect", "eval"])("%s异常不打印异常值且清理已构造连接", async (at) => {
    const failure = new Error("public-private-marker");
    if (at === "env")
      cli.load.mockImplementationOnce(() => {
        throw failure;
      });
    if (at === "connect") cli.connect.mockRejectedValueOnce(failure);
    if (at === "eval") cli.evaluate.mockRejectedValueOnce(failure);
    expect(await main(["--inspect"])).toBe(1);
    expect(JSON.stringify([...output.mock.calls, ...errors.mock.calls])).not.toContain(
      failure.message,
    );
    expect(cli.disconnect).toHaveBeenCalledTimes(at === "env" ? 0 : 1);
  });
  it.each(["connect", "quit"])("不合作%s被原250ms界限关闭，迟到错误消费", async (at) => {
    vi.useFakeTimers();
    const g = gate();
    if (at === "connect") cli.connect.mockImplementation(g.work as () => Promise<undefined>);
    else cli.quit.mockImplementation(g.work as () => Promise<string>);
    const running = main(["--inspect"]);
    await g.entered;
    await vi.advanceTimersByTimeAsync(250);
    expect(await running).toBe(at === "connect" ? 1 : 0);
    expect(cli.disconnect).toHaveBeenCalledOnce();
    g.reject(new Error("public-private-marker"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
