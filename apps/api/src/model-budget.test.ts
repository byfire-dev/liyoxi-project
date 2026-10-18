import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiModelBudgetTransport } from "./model-budget.js";

type Client = {
  status: string;
  on: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  eval: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
  quit: ReturnType<typeof vi.fn<() => Promise<string>>>;
  disconnect: ReturnType<typeof vi.fn>;
};
const ports = vi.hoisted(() => ({
  clients: [] as Client[],
  configurations: [] as Array<{ url: string; options: Record<string, unknown> }>,
}));
vi.mock("ioredis", () => ({
  Redis: class {
    constructor(url: string, options: Record<string, unknown>) {
      const client: Client = {
        status: "wait",
        on: vi.fn(),
        connect: vi.fn(async () => {
          client.status = "connecting";
        }),
        eval: vi.fn(async () => "reply"),
        quit: vi.fn(async () => "OK"),
        disconnect: vi.fn(),
      };
      ports.clients.push(client);
      ports.configurations.push({ url, options });
      return client;
    }
  },
}));
beforeEach(() => {
  ports.clients.length = 0;
  ports.configurations.length = 0;
});
const build = (testKeyPrefix?: string) =>
  createApiModelBudgetTransport({
    redisUrl: "redis://public.invalid",
    appEnv: "test",
    ...(testKeyPrefix ? { testKeyPrefix } : {}),
    onError: vi.fn(),
  });
describe("API专有模型预算Redis连接", () => {
  it("构造零IO，沿worker关闭排队/重放及250ms时限；未就绪不排队，ready只eval一次", async () => {
    const pair = build(),
      client = ports.clients[0]!;
    expect(ports.configurations[0]!.options).toMatchObject({
      lazyConnect: true,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 250,
      commandTimeout: 250,
    });
    expect((ports.configurations[0]!.options.retryStrategy as () => null)()).toBeNull();
    expect(ports.configurations[0]!.options).not.toHaveProperty("keyPrefix");
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled();
    await expect(
      pair.transport.eval("script", ["lyx:test:model_budget:v1"], ["1"]),
    ).rejects.toThrow("尚未就绪");
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.eval).not.toHaveBeenCalled();
    client.status = "ready";
    await expect(pair.transport.eval("script", ["lyx:test:model_budget:v1"], ["1"])).resolves.toBe(
      "reply",
    );
    expect(client.eval).toHaveBeenCalledExactlyOnceWith(
      "script",
      1,
      "lyx:test:model_budget:v1",
      "1",
    );
    await pair.close();
  });
  it("只允许test自有前缀；两实例不共享连接，连接故障不重放且close不影响另一实例", async () => {
    expect(() =>
      createApiModelBudgetTransport({
        redisUrl: "redis://public.invalid",
        appEnv: "prod",
        testKeyPrefix: "lyx:test:owned:",
        onError: vi.fn(),
      }),
    ).toThrow();
    const first = build("lyx:test:owned:"),
      a = ports.clients[0]!,
      second = build(),
      b = ports.clients[1]!;
    expect(ports.configurations[0]!.options.keyPrefix).toBe("lyx:test:owned:");
    a.status = "end";
    b.status = "ready";
    await expect(first.transport.eval("one", ["key"], [])).rejects.toThrow("尚未就绪");
    expect(a.connect).not.toHaveBeenCalled();
    expect(a.eval).not.toHaveBeenCalled();
    const closing = first.close();
    expect(first.close()).toBe(closing);
    await closing;
    await expect(first.transport.eval("late", ["key"], [])).rejects.toThrow("已关闭");
    expect(a.disconnect).toHaveBeenCalledOnce();
    expect(b.disconnect).not.toHaveBeenCalled();
    expect(await second.transport.eval("two", ["key"], [])).toBe("reply");
    await second.close();
  });
  it("close先拒新并等待在途eval；quit异常也断开，重复关闭只收一次", async () => {
    const pair = build(),
      client = ports.clients[0]!;
    client.status = "ready";
    let release!: () => void;
    client.eval.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    client.quit.mockRejectedValueOnce(new Error("public-quit-failure"));
    const work = pair.transport.eval("script", ["key"], []),
      closing = pair.close();
    const outcome = expect(closing).rejects.toThrow("public-quit-failure");
    expect(pair.close()).toBe(closing);
    expect(client.quit).not.toHaveBeenCalled();
    await expect(pair.transport.eval("late", ["key"], [])).rejects.toThrow("已关闭");
    release();
    await work;
    await outcome;
    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
});
