import { createServerErrorReporter } from "@liyoxi/services";
import { expect, it, vi } from "vitest";
import { useTestApi } from "../src/testing/index.js";
import { SAMPLE_HANDLERS } from "./fixtures.js";

const api = useTestApi();
it("W227服务端：真实HTTP仅5xx上报，原响应及日志保留且未配置仍正常", async () => {
  const h = await api.start({ handlers: SAMPLE_HANDLERS }),
    send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
  const reporter = createServerErrorReporter({
    component: "api",
    release: "sha-0123456789ab",
    artifactRoot: new URL("file:///app/apps/api/dist/"),
    dsn: "https://fictionalserver@errors.example.invalid/42",
    clock: h.clock,
    logger: h.runtime.logger,
    fetch: send,
  });
  // 只替换外部监控IO，应用/正式onError/响应/日志都是真实支架的公口。
  Object.defineProperty(h.runtime, "serverErrors", { value: reporter, configurable: true });
  const id = "01900000-0000-7000-8000-000000000001";
  try {
    const crash = await h.request(`/api/v1/m/lyxtest-things/${id}?fail=crash`);
    expect(crash.status).toBe(500);
    expect(await crash.json()).toMatchObject({ error: "INTERNAL", retryable: false });
    await reporter.drain();
    expect(send).toHaveBeenCalledTimes(1);
    const raw = String(send.mock.calls[0]![1]!.body),
      event = JSON.parse(raw.split("\n")[2]!);
    expect(event).toMatchObject({
      dist: "api",
      release: "sha-0123456789ab",
      exception: { values: [{ value: "API request failed" }] },
    });
    expect(raw).not.toMatch(
      /stack"|cause|details|\/Users\/|fixture\.ts|postgresql|hunter2|内部细节/,
    );
    expect(h.logs.filter((line) => line.evt === "http.error")).toHaveLength(1);
    const rejected = await h.request(`/api/v1/m/lyxtest-things/${id}?fail=app`);
    expect(rejected.status).toBe(409);
    await reporter.drain();
    expect(send).toHaveBeenCalledTimes(1);
    await reporter.close();
    // 关闭/未配监控不改变原500与日志底座。
    expect((await h.request(`/api/v1/m/lyxtest-things/${id}?fail=crash`)).status).toBe(500);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    await reporter.close();
  }
}, 60_000);
