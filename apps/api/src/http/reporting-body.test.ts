import {
  mAnalyticsEventBatchCreate,
  mClientErrorCreate,
  adminClientErrorCreate,
  mSubscribeResultCreate,
} from "@liyoxi/contract";
import type { Runtime } from "@liyoxi/services";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ApiEnv } from "../context.js";
import { reportingBody } from "./reporting-body.js";

const unusedRuntime = {} as Runtime;
function streamBody(chunks: Uint8Array[]) {
  let position = 0,
    canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = chunks[position++];
      if (part) controller.enqueue(part);
      else controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
  return { stream, canceled: () => canceled };
}
function request(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request("http://localhost/report", {
    method: "POST",
    body: stream,
    headers,
    duplex: "half",
  } as RequestInit);
}
describe("客户端上报传输层逐块限量", () => {
  for (const [route, limit] of [
    [mAnalyticsEventBatchCreate, 64 * 1024],
    [mClientErrorCreate, 200 * 1024],
    [adminClientErrorCreate, 200 * 1024],
  ] as const) {
    it(`${route.operationId}实际字节边界/noCL/虚报CL，溢出cancel且释放reader`, async () => {
      const app = new Hono<ApiEnv>();
      const middleware = reportingBody(route, unusedRuntime)!;
      let handlerCalls = 0;
      app.post("/report", middleware, async (c) => {
        handlerCalls++;
        const bytes = await c.req.arrayBuffer();
        expect(c.req.raw.body?.locked).toBe(false);
        return c.text(String(bytes.byteLength));
      });
      const exact = streamBody([new Uint8Array(limit - 1), new Uint8Array(1)]);
      expect(await (await app.fetch(request(exact.stream))).text()).toBe(String(limit));
      const headerVariants: Record<string, string>[] = [{}, { "Content-Length": "1" }];
      for (const headers of headerVariants) {
        const large = streamBody([new Uint8Array(limit), new Uint8Array(1), new Uint8Array(3)]);
        const response = await app.fetch(request(large.stream, headers));
        expect(response.status).toBe(413);
        expect(await response.text()).toBe("Payload Too Large");
        expect(large.canceled()).toBe(true);
        expect(large.stream.locked).toBe(false);
      }
      expect(handlerCalls).toBe(1);
    });
  }
  it("缓存供原Hono JSON解析复用、UTF8按字节而非字符计数", async () => {
    const app = new Hono<ApiEnv>();
    app.post("/report", reportingBody(mAnalyticsEventBatchCreate, unusedRuntime)!, async (c) =>
      c.json(await c.req.json()),
    );
    const raw = JSON.stringify({ text: "狸有戏" });
    const input = streamBody([new TextEncoder().encode(raw)]);
    expect(
      await (await app.fetch(request(input.stream, { "Content-Type": "application/json" }))).json(),
    ).toEqual({ text: "狸有戏" });
    const large = streamBody([new TextEncoder().encode("狸".repeat(22_000))]);
    expect((await app.fetch(request(large.stream))).status).toBe(413);
  });
  it("其它operation无中间件，不对subscribe无端增加大小规则", () => {
    expect(reportingBody(mSubscribeResultCreate, unusedRuntime)).toBeNull();
    expect(
      reportingBody({ ...mSubscribeResultCreate, operationId: "constructor" }, unusedRuntime),
    ).toBeNull();
  });
  it("signal中止真实pending read，取消流/释放reader，不进入业务处理器", async () => {
    const signal = new AbortController();
    let canceled = false,
      handlerCalls = 0;
    let started!: () => void;
    const pulled = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        started();
      },
      cancel() {
        canceled = true;
      },
    });
    const app = new Hono<ApiEnv>();
    app.post("/report", reportingBody(mClientErrorCreate, unusedRuntime)!, (c) => {
      handlerCalls++;
      return c.text("unexpected");
    });
    const pending = app.fetch(
      new Request("http://localhost/report", {
        method: "POST",
        body: stream,
        signal: signal.signal,
        duplex: "half",
      } as RequestInit),
    );
    await pulled;
    signal.abort();
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Request Aborted");
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
    expect(handlerCalls).toBe(0);
  });
});
