import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withBeforeCall } from "../types.js";
import { createFakeAsr } from "../../testing/index.js";
import { signAsr } from "./sign.js";
import { createTencentAsr } from "./tencent.js";

// 只使用公开虚构凭据与 loopback HTTP；不连接腾讯云，不获取真实 URL。
const config = { secretId: "AKIDEXAMPLE", secretKey: "SECRETKEYEXAMPLE" };
const now = () => new Date("2019-02-25T16:17:45.000Z");
const url = "https://example.invalid/short-lived-audio.m4a?signature=private-url";
const servers = new Set<Server>();
const drivers = new Set<ReturnType<typeof createTencentAsr>>();
const json = (res: ServerResponse, value: unknown) => res.end(JSON.stringify(value));
const submitted = { Response: { RequestId: "request-submit", Data: { TaskId: 1234 } } };
function task(overrides: Record<string, unknown> = {}) {
  return {
    Response: {
      RequestId: "request-query",
      Data: {
        TaskId: 1234,
        Status: 2,
        StatusStr: "success",
        Result: "真实分句文本",
        AudioDuration: 2.38,
        ResultDetail: [{ FinalSentence: "真实分句文本", StartMs: 20, EndMs: 2380 }],
        ...overrides,
      },
    },
  };
}
async function local(
  reply: (request: { headers: IncomingHttpHeaders; body: string }, res: ServerResponse) => void,
) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    calls += 1;
    reply({ headers: req.headers, body: Buffer.concat(parts).toString("utf8") }, res);
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试 HTTP 未就绪");
  const forwarding: typeof fetch = (target, init) => {
    expect(target).toBe("https://asr.tencentcloudapi.com/");
    expect(new Headers(init?.headers).get("host")).toBe("asr.tencentcloudapi.com");
    expect(init?.redirect).toBe("error");
    return fetch(`http://127.0.0.1:${address.port}/`, init);
  };
  return { fetch: forwarding, calls: () => calls };
}
function driver(options: { fetch: typeof fetch; timeoutMs?: number }) {
  const owned = createTencentAsr(config, { ...options, now });
  drivers.add(owned);
  return owned;
}
afterEach(async () => {
  await Promise.all([...drivers].map((owned) => owned.close()));
  drivers.clear();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
});

describe("腾讯 ASR 异步协议：真实本地 HTTP", () => {
  it("提交只送固定模型、单声道与分句格式，不夹带回调或默认付费附加能力", async () => {
    const http = await local(({ body, headers }, res) => {
      expect(JSON.parse(body)).toEqual({
        EngineModelType: "16k_zh",
        ChannelNum: 1,
        ResTextFormat: 3,
        SourceType: 0,
        Url: url,
      });
      expect(headers["x-tc-action"]).toBe("CreateRecTask");
      expect(headers["x-tc-version"]).toBe("2019-06-14");
      expect(headers["x-tc-timestamp"]).toBe("1551111465");
      expect(headers["authorization"]).toBe(
        signAsr({ ...config, timestamp: 1551111465, payload: body }),
      );
      json(res, submitted);
    });
    const owned = driver(http);
    expect(await owned.provider.submit({ url })).toEqual({
      ok: true,
      value: { taskId: "1234", requestId: "request-submit" },
    });
    expect(await owned.provider.transcribe({ url })).toMatchObject({
      ok: false,
      reason: "unsupported",
    });
    expect(http.calls()).toBe(1);
  });

  it.each([
    [0, "waiting", "waiting"],
    [1, "doing", "doing"],
    [3, "failed", "failed"],
  ] as const)("保留官方状态 %i；不把空结果补成成功", async (status, statusStr, state) => {
    const http = await local(({ body, headers }, res) => {
      expect(body).toBe('{"TaskId":1234}');
      expect(headers["x-tc-action"]).toBe("DescribeTaskStatus");
      json(
        res,
        task({
          Status: status,
          StatusStr: statusStr,
          Result: "",
          AudioDuration: null,
          ResultDetail: null,
          ErrorMsg: "供应商原始错误不能输出",
        }),
      );
    });
    const result = await driver(http).provider.query({ taskId: "1234" });
    expect(result).toEqual({
      ok: true,
      value: {
        state,
        taskId: "1234",
        requestId: "request-query",
        ...(state === "failed" ? { code: "recognition_failed" } : {}),
      },
    });
    expect(JSON.stringify(result)).not.toContain("供应商原始错误");
  });

  it("成功事实保留秒时长与毫秒分句，不用最后分句推算时长", async () => {
    const http = await local((_req, res) => json(res, task()));
    expect(await driver(http).provider.query({ taskId: "1234" })).toEqual({
      ok: true,
      value: {
        state: "succeeded",
        taskId: "1234",
        requestId: "request-query",
        text: "真实分句文本",
        durationSec: 2.38,
        segments: [{ text: "真实分句文本", startMs: 20, endMs: 2380 }],
      },
    });
  });

  it.each([
    { AudioDuration: null },
    { AudioDuration: 0 },
    { AudioDuration: "2.38" },
    { AudioDuration: 18001 },
    { Result: null },
    { Result: " " },
    { ResultDetail: null },
    { ResultDetail: [] },
    { ResultDetail: [{ FinalSentence: null, StartMs: 20, EndMs: 2380 }] },
    { ResultDetail: [{ FinalSentence: "文本", StartMs: 0.02, EndMs: 2.38 }] },
    { ResultDetail: [{ FinalSentence: "文本", StartMs: 20, EndMs: 3000 }] },
    { ResultDetail: [{ FinalSentence: "文本", StartMs: 100, EndMs: 20 }] },
    { TaskId: 1235 },
    { Status: 4 },
    { StatusStr: "waiting" },
  ])("成功字段缺失或单位错误明确拒绝：%j", async (overrides) => {
    const http = await local((_req, res) => json(res, task(overrides)));
    expect(await driver(http).provider.query({ taskId: "1234" })).toEqual({
      ok: false,
      reason: "unavailable",
      message: "录音转写响应不完整",
    });
    expect(http.calls()).toBe(1);
  });

  it.each(["9007199254740993", "18446744073709551615"])(
    "uint64 %s 在提交与查询之间不经浮点舍入",
    async (taskId) => {
      let round = 0;
      const http = await local(({ body }, res) => {
        round += 1;
        if (round === 1)
          res.end(`{"Response":{"RequestId":"big-submit","Data":{"TaskId":${taskId}}}}`);
        else {
          expect(body).toBe(`{"TaskId":${taskId}}`);
          res.end(
            `{"Response":{"RequestId":"big-query","Data":{"TaskId":${taskId},"Status":0,"StatusStr":"waiting"}}}`,
          );
        }
      });
      const owned = driver(http);
      const result = await owned.provider.submit({ url });
      expect(result).toEqual({ ok: true, value: { taskId, requestId: "big-submit" } });
      expect(await owned.provider.query({ taskId })).toEqual({
        ok: true,
        value: { taskId, requestId: "big-query", state: "waiting" },
      });
      expect(http.calls()).toBe(2);
    },
  );
  it("官方 string TaskId 也保留精度；不同日相同 TaskId 不被本地去重", async () => {
    const http = await local((_req, res) =>
      json(res, {
        Response: { RequestId: "string-submit", Data: { TaskId: "9007199254740993" } },
      }),
    );
    const owned = driver(http);
    expect(await owned.provider.submit({ url })).toMatchObject({
      ok: true,
      value: { taskId: "9007199254740993" },
    });
    expect(await owned.provider.submit({ url })).toMatchObject({
      ok: true,
      value: { taskId: "9007199254740993" },
    });
    expect(http.calls()).toBe(2);
  });
  it.each(["18446744073709551616", "-1", "1e3", "1.5"])(
    "提交非法数字 token %s 不查询舍入后的任务",
    async (token) => {
      const http = await local((_req, res) =>
        res.end(`{"Response":{"RequestId":"bad-id","Data":{"TaskId":${token}}}}`),
      );
      expect(await driver(http).provider.submit({ url })).toMatchObject({
        ok: false,
        acceptance: "unknown",
        code: "invalid_response",
      });
      expect(http.calls()).toBe(1);
    },
  );

  it.each([
    "AuthFailure.InvalidAuthorization",
    "InvalidParameterValue",
    "MissingParameter",
    "RequestLimitExceeded.UinLimitExceeded",
  ])("明确拒绝 %s 才证明未受理", async (code) => {
    const http = await local((_req, res) =>
      json(res, {
        Response: {
          RequestId: "reject-request",
          Error: { Code: code, Message: `${url}-${config.secretKey}-原文` },
        },
      }),
    );
    const result = await driver(http).provider.submit({ url });
    expect(result).toEqual({
      ok: false,
      reason: "rejected",
      message: "录音转写提交被拒绝",
      acceptance: "not_accepted",
      code: "provider_rejected",
    });
    expect(JSON.stringify(result)).not.toContain(url);
    expect(JSON.stringify(result)).not.toContain(config.secretKey);
    expect(JSON.stringify(result)).not.toContain("原文");
    expect(http.calls()).toBe(1);
  });

  it.each(["InternalError.FailAccessDatabase", "FailedOperation.ErrorDownFile", "Future.Error"])(
    "没有明确受理证明的官方错误 %s 不自动重提",
    async (code) => {
      const http = await local((_req, res) =>
        json(res, {
          Response: {
            RequestId: "uncertain-request",
            Error: { Code: code, Message: "敏感供应商详情" },
          },
        }),
      );
      expect(await driver(http).provider.submit({ url })).toEqual({
        ok: false,
        reason: "unavailable",
        message: "录音转写提交结果未知",
        acceptance: "unknown",
        code: "unknown_outcome",
      });
      expect(http.calls()).toBe(1);
    },
  );
  it.each(["{}", "not-json", '{"Response":{"RequestId":"bad","Data":null}}'])(
    "坏响应只返回未知受理：%s",
    async (body) => {
      const http = await local((_req, res) => res.end(body));
      expect(await driver(http).provider.submit({ url })).toMatchObject({
        ok: false,
        acceptance: "unknown",
        code: "invalid_response",
      });
      expect(http.calls()).toBe(1);
    },
  );
  it.each([400, 503])("HTTP %i 没有受理证明，不自动重提", async (status) => {
    const http = await local((_req, res) => {
      res.statusCode = status;
      res.end("敏感正文");
    });
    expect(await driver(http).provider.submit({ url })).toMatchObject({
      ok: false,
      acceptance: "unknown",
      code: "http_error",
    });
    expect(http.calls()).toBe(1);
  });
  it("查询官方 NoSuchTask 是受控失败，不伪造终态或创建新任务", async () => {
    const http = await local((_req, res) =>
      json(res, {
        Response: {
          RequestId: "missing-task",
          Error: { Code: "FailedOperation.NoSuchTask", Message: "秘密" },
        },
      }),
    );
    expect(await driver(http).provider.query({ taskId: "1234" })).toEqual({
      ok: false,
      reason: "rejected",
      message: "录音转写查询被拒绝",
    });
    expect(http.calls()).toBe(1);
  });
  it("查询内部错误仍是 unavailable，不伪造官方 failed 状态", async () => {
    const http = await local((_req, res) =>
      json(res, {
        Response: {
          RequestId: "query-internal",
          Error: { Code: "InternalError.FailAccessDatabase", Message: "秘密" },
        },
      }),
    );
    expect(await driver(http).provider.query({ taskId: "1234" })).toEqual({
      ok: false,
      reason: "unavailable",
      message: "录音转写查询失败",
    });
    expect(http.calls()).toBe(1);
  });

  it("输入非法和开始前取消均零 HTTP，独立于未知受理", async () => {
    const http = await local((_req, res) => json(res, submitted));
    const owned = driver(http);
    const controller = new AbortController();
    controller.abort();
    expect(await owned.provider.submit({ url, signal: controller.signal })).toMatchObject({
      ok: false,
      acceptance: "not_accepted",
      code: "aborted",
    });
    for (const value of [
      "file:///private",
      "http://example.invalid",
      "https://u:p@example.invalid/a",
      "bad",
    ])
      expect(await owned.provider.submit({ url: value })).toMatchObject({
        ok: false,
        acceptance: "not_accepted",
        code: "invalid_input",
      });
    for (const taskId of ["1e3", "18446744073709551616", "01", "-1"])
      expect(await owned.provider.query({ taskId })).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    expect(http.calls()).toBe(0);
  });
  it("传输抛出的错误、超时都不泄密或重试", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`${url}-${config.secretKey}`));
    const result = await driver({ fetch: transport }).provider.submit({ url });
    expect(result).toEqual({
      ok: false,
      reason: "unavailable",
      message: "录音转写连接失败",
      acceptance: "unknown",
      code: "transport",
    });
    expect(transport).toHaveBeenCalledTimes(1);
    let received!: () => void;
    const ready = new Promise<void>((resolve) => {
      received = resolve;
    });
    const http = await local((_req, res) => {
      res.writeHead(200);
      res.write('{"Response":');
      received();
    });
    const timeoutTransport = vi.fn(http.fetch);
    const owned = driver({ fetch: timeoutTransport, timeoutMs: 20 });
    // 先确认真实 HTTP 已收到请求，再推进期限，不依赖 CI 在 20ms 内完成建连。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = owned.provider.submit({ url });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.race([
        ready,
        pending.then(() => {
          throw new Error("录音转写调用在到达本地HTTP前结束");
        }),
      ]);
      await vi.advanceTimersByTimeAsync(19);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({
        ok: false,
        reason: "unavailable",
        message: "录音转写调用超时",
        acceptance: "unknown",
        code: "timeout",
      });
      expect(http.calls()).toBe(1);
      expect(timeoutTransport).toHaveBeenCalledTimes(1);
    } finally {
      try {
        await owned.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });
  it("在途取消真实响应流：未知受理；close 等待自有请求 finally 后拒绝晚调用", async () => {
    let received!: () => void;
    const ready = new Promise<void>((resolve) => {
      received = resolve;
    });
    const http = await local((_req, res) => {
      res.writeHead(200);
      res.write('{"Response":');
      received();
    });
    const owned = driver(http);
    const controller = new AbortController();
    const pending = owned.provider.submit({ url, signal: controller.signal });
    await ready;
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, acceptance: "unknown", code: "aborted" });
    await owned.close();
    expect(await owned.provider.submit({ url })).toMatchObject({
      ok: false,
      acceptance: "not_accepted",
      code: "closed",
    });
    expect(await owned.provider.query({ taskId: "1234" })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(http.calls()).toBe(1);
  });
  it("两个驱动 close 互不串；close 中真实取消且等待未完响应", async () => {
    let received!: () => void;
    const ready = new Promise<void>((resolve) => {
      received = resolve;
    });
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const held = await local((_req, res) => {
      res.on("close", disconnected);
      res.writeHead(200);
      res.write("{");
      received();
    });
    const first = driver(held);
    const http = await local((_req, res) => json(res, task()));
    const second = driver(http);
    const pending = first.provider.submit({ url });
    await ready;
    await first.close();
    await closed;
    expect(await pending).toMatchObject({ ok: false, acceptance: "unknown", code: "closed" });
    expect(await second.provider.query({ taskId: "1234" })).toMatchObject({
      ok: true,
      value: { state: "succeeded" },
    });
    expect(held.calls()).toBe(1);
  });
  it("close 等待真实 reader.cancel finally，不提前报告所属请求已关闭", async () => {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const canceled = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const transport: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
          },
          async cancel() {
            reached();
            await gate;
          },
        }),
      );
    const owned = driver({ fetch: transport });
    const pending = owned.provider.submit({ url });
    try {
      await canceled;
      let finished = false;
      const closing = owned.close().then(() => {
        finished = true;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      release();
      await closing;
      expect(await pending).toMatchObject({
        ok: false,
        code: "invalid_response",
        acceptance: "unknown",
      });
      expect(finished).toBe(true);
    } finally {
      release();
      await owned.close();
    }
  });
  it("响应超限取消读取；重定向不跟随且不重发", async () => {
    const huge = await local((_req, res) => res.end(Buffer.alloc(4 * 1024 * 1024 + 1, 120)));
    expect(await driver(huge).provider.submit({ url })).toMatchObject({
      ok: false,
      acceptance: "unknown",
      code: "invalid_response",
    });
    const redirect = await local((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "https://example.invalid/other");
      res.end();
    });
    expect(await driver(redirect).provider.submit({ url })).toMatchObject({
      ok: false,
      acceptance: "unknown",
      code: "transport",
    });
    expect(huge.calls()).toBe(1);
    expect(redirect.calls()).toBe(1);
  });
  it("外呼 guard 先于校验、签名或请求；同步旧方法不冒充异步完成", async () => {
    const transport = vi.fn<typeof fetch>();
    const owned = driver({ fetch: transport });
    const guarded = withBeforeCall("asr", owned.provider, () => {
      throw new Error("guard");
    });
    await expect(guarded.submit({ url: "invalid" })).rejects.toThrow("guard");
    await expect(guarded.query({ taskId: "invalid" })).rejects.toThrow("guard");
    await expect(guarded.transcribe({ url })).rejects.toThrow("guard");
    expect(transport).not.toHaveBeenCalled();
  });
  it("配置和单次期限非法仅固定错误，不回显配置", () => {
    for (const timeoutMs of [0, 10001, NaN, 1.5])
      expect(() =>
        createTencentAsr(config, {
          now,
          timeoutMs,
        }),
      ).toThrow("录音转写配置不合法");
    expect(() => createTencentAsr({ ...config, secretId: `${url}\nsecret` }, { now })).toThrow(
      "录音转写配置不合法",
    );
  });
});

describe("ASR 替身：保旧同步事实，新增显式异步状态与受理未知", () => {
  it("旧 transcribe 默认文本和30秒不变；新任务需显式提供完成事实", async () => {
    const fake = createFakeAsr();
    expect(await fake.transcribe({ url })).toEqual({
      ok: true,
      value: { text: "这是替身给的转写文本。", durationSec: 30 },
    });
    const submittedTask = await fake.submit({ url });
    if (!submittedTask.ok) throw new Error("替身提交失败");
    const taskId = submittedTask.value.taskId;
    expect(await fake.query({ taskId })).toMatchObject({ ok: true, value: { state: "waiting" } });
    fake.tasks.set(taskId, {
      state: "succeeded",
      taskId,
      requestId: "fake-query",
      text: "替身文本",
      durationSec: 1,
      segments: [{ text: "替身文本", startMs: 0, endMs: 1000 }],
    });
    expect(await fake.query({ taskId })).toMatchObject({
      ok: true,
      value: { state: "succeeded", durationSec: 1 },
    });
    expect(fake.callsOf("submit")).toHaveLength(1);
    expect(fake.callsOf("query")).toHaveLength(2);
  });
  it("新增 submit 失败/延迟可编排；开始前取消与受理后的取消明确区分", async () => {
    const clock = { now: () => new Date("2026-10-10T00:00:00Z") };
    const fake = createFakeAsr({ clock });
    fake.failNext("submit");
    expect(await fake.submit({ url })).toMatchObject({
      ok: false,
      acceptance: "unknown",
      code: "unknown_outcome",
    });
    const before = new AbortController();
    before.abort();
    expect(await fake.submit({ url, signal: before.signal })).toMatchObject({
      ok: false,
      acceptance: "not_accepted",
      code: "aborted",
    });
    const during = new AbortController();
    fake.delayNext("submit", 3000);
    const pending = fake.submit({ url, signal: during.signal });
    expect(fake.pendingCalls()).toBe(1);
    expect(fake.tasks.size).toBe(1);
    during.abort();
    expect(await pending).toMatchObject({ ok: false, acceptance: "unknown", code: "aborted" });
    expect(fake.pendingCalls()).toBe(0);
  });
});
