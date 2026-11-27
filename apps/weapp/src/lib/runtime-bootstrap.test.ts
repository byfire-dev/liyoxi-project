import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tarojs/taro", () => ({ default: {} }));
vi.mock("./platform.taro", () => ({
  send: vi.fn(),
  requestSubscribe: vi.fn(),
  clientInfo: () => ({ version: "0.1.0", platform: "ios", envVersion: "develop" }),
  storage: { get: () => null, set: vi.fn(), remove: vi.fn() },
  privacyApi: () => ({}),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("__LYX_API_BASE_URL__", "https://example.invalid");
  vi.stubGlobal("__LYX_SENTRY_DSN__", "");
});

it.each(["token", "store"] as const)(
  "后台启动请求晚到时不能越过 %s 变化覆盖已刷新的开关",
  async (change) => {
    const { connectServer } = await import("./server");
    const { useSessionStore } = await import("../stores/session");
    const { useContextStore } = await import("../stores/context");
    const { useBootstrapStore } = await import("../stores/bootstrap");
    let resolve!: (value: { flags: { "weapp.video.sample.enabled": boolean } }) => void;
    connectServer({
      fetchBootstrap: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const { startApp } = await import("./runtime");
    startApp(undefined);
    if (change === "token") useSessionStore.setState({ accessToken: "new-session" });
    else useContextStore.getState().switchStore("new-store");
    useBootstrapStore.getState().apply({ flags: { "weapp.video.sample.enabled": true } }, 123);
    resolve({ flags: { "weapp.video.sample.enabled": false } });
    await new Promise<void>((done) => setTimeout(done, 0));
    expect(useBootstrapStore.getState().data.flags["weapp.video.sample.enabled"]).toBe(true);
    expect(useBootstrapStore.getState().fetchedAt).toBe(123);
  },
);
