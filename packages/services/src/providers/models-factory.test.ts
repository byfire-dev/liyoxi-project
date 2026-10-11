import { afterEach, describe, expect, it, vi } from "vitest";

import { callWithSample, createRecordingLogger } from "../testing/index.js";
import {
  createProviders,
  describeProviders,
  PROVIDER_APP_ENVS,
  PROVIDER_METHODS,
  PROVIDER_NAMES,
  ProviderConfigError,
} from "./index.js";
import type {
  BeforeProviderCall,
  CreateProvidersOptions,
  DomesticLlmConfig,
  ProviderAppEnv,
  ProviderCall,
  TencentAsrConfig,
} from "./index.js";

// 仅公开虚构配置与注入 HTTP；真实构造器/解析/取消路径不调用模型平台。
const asrConfig: TencentAsrConfig = { secretId: "AKIDEXAMPLE", secretKey: "PUBLIC_ASR_KEY" };
const audio = "https://assets.example.invalid/audio.m4a?token=private-audio";
const taskId = "9007199254740993";
const fixedTime = new Date("2026-10-12T00:00:00.000Z");
const digest = {
  title: "菜单",
  keypoints: ["牛肉面"],
  contentTags: ["menu"],
  suggestedUsage: [],
  faceHint: "none",
  qualityNotes: [],
};
const vision = {
  description: "一碗牛肉面",
  quality: "清晰",
  hasPeople: false,
  identifiableCustomerFace: false,
  textInImage: "菜单",
};
type Close = () => Promise<void>;
type Selection = "none" | "asr" | "llm" | "both";
type Sent = { url: string; headers: Headers; body: string; signal?: AbortSignal | null };
const owned = new Set<Close>();

function configuration(): DomesticLlmConfig {
  return {
    text: {
      primary: { vendor: "deepseek", model: "text-primary", apiKey: "PUBLIC_TEXT_PRIMARY" },
      backup: { vendor: "ark", model: "text-backup", apiKey: "PUBLIC_TEXT_BACKUP" },
    },
    vision: {
      primary: { vendor: "ark", model: "vision-primary", apiKey: "PUBLIC_VISION_PRIMARY" },
      backup: {
        vendor: "bailian",
        model: "vision-backup",
        apiKey: "PUBLIC_VISION_BACKUP",
        workspaceId: "vision-space",
      },
    },
  };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function chat(value: unknown) {
  return response({
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } },
    ],
  });
}
function setup(selection: Selection = "both", appEnv: ProviderAppEnv = "prod") {
  const logger = createRecordingLogger();
  const asrSent: Sent[] = [];
  const llmSent: Sent[] = [];
  const beforeCall = vi.fn<BeforeProviderCall>();
  const now = vi.fn(() => new Date(fixedTime));
  const asrClose = vi.fn<(close: Close) => void>((close) => void owned.add(close));
  const llmClose = vi.fn<(close: Close) => void>((close) => void owned.add(close));
  const asrFetch = vi.fn<typeof fetch>(async (url, init) => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body);
    asrSent.push({ url: String(url), headers, body, signal: init?.signal });
    if (headers.get("x-tc-action") === "CreateRecTask")
      return response({ Response: { RequestId: "request-submit", Data: { TaskId: taskId } } });
    const id = /"TaskId":(\d+)/.exec(body)?.[1];
    return response({
      Response: {
        RequestId: "request-query",
        Data: {
          TaskId: id,
          Status: 2,
          StatusStr: "success",
          Result: "公开虚构转写",
          AudioDuration: 1.2,
          ResultDetail: [{ FinalSentence: "公开虚构转写", StartMs: 0, EndMs: 1200 }],
        },
      },
    });
  });
  const llmFetch = vi.fn<typeof fetch>(async (url, init) => {
    const body = String(init?.body);
    llmSent.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body,
      signal: init?.signal,
    });
    if (body.includes("identifiableCustomerFace")) return chat(vision);
    if (body.includes("keypoints")) return chat(digest);
    if (body.includes('\\"points\\"')) return chat({ points: ["牛肉面"] });
    return chat({ description: "一碗牛肉面", tags: ["餐饮"] });
  });
  const hasAsr = selection === "asr" || selection === "both";
  const hasLlm = selection === "llm" || selection === "both";
  const options: CreateProvidersOptions = {
    appEnv,
    logger,
    beforeCall,
    settings: {
      ...(hasAsr ? { asr: { ...asrConfig } } : {}),
      ...(hasLlm ? { llm: configuration() } : {}),
    },
    ...(hasAsr ? { asr: { now, fetch: asrFetch, registerClose: asrClose } } : {}),
    ...(hasLlm ? { llm: { fetch: llmFetch, registerClose: llmClose } } : {}),
  };
  return {
    options,
    logger,
    beforeCall,
    now,
    asrClose,
    llmClose,
    asrFetch,
    llmFetch,
    asrSent,
    llmSent,
  };
}
function closeOf(h: ReturnType<typeof setup>, name: "asr" | "llm"): Close {
  const close = (name === "asr" ? h.asrClose : h.llmClose).mock.calls[0]?.[0];
  if (!close) throw new Error("测试未登记驱动关闭函数");
  return close;
}
function blockingTransport() {
  const entered = deferred<AbortSignal>();
  const aborted = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    signal = init?.signal ?? undefined;
    if (!signal) throw new Error("驱动未传取消信号");
    const current = signal;
    const abort = () => {
      aborted.resolve();
    };
    current.addEventListener("abort", abort, { once: true });
    entered.resolve(current);
    try {
      if (current.aborted) abort();
      await release.promise;
      throw new Error("公开虚构的传输取消");
    } finally {
      current.removeEventListener("abort", abort);
    }
  });
  return { transport, entered, aborted, release, signal: () => signal };
}
afterEach(async () => {
  await Promise.all([...owned].map((close) => close()));
  owned.clear();
  vi.restoreAllMocks();
});

const selections: Selection[] = ["none", "asr", "llm", "both"];
const environments = PROVIDER_APP_ENVS.flatMap((appEnv) =>
  selections.map((selection) => ({ appEnv, selection })),
);
describe("显式模型工厂选择与原默认", () => {
  it.each(environments)(
    "$appEnv/$selection：构造零IO且每驱动只登记一次",
    ({ appEnv, selection }) => {
      const nativeFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("构造阶段不应请求原生HTTP");
      });
      const h = setup(selection, appEnv);
      const providers = createProviders(h.options);
      const defaults = createProviders({ appEnv, logger: createRecordingLogger() });
      const hasAsr = selection === "asr" || selection === "both";
      const hasLlm = selection === "llm" || selection === "both";
      expect(providers.asr.status).toBe(hasAsr ? "tencent" : "unconfigured");
      expect(providers.llm.status).toBe(hasLlm ? "domestic-llm" : "unconfigured");
      expect(providers.asr.configured).toBe(hasAsr);
      expect(providers.llm.configured).toBe(hasLlm);
      for (const name of PROVIDER_NAMES.filter((name) => name !== "asr" && name !== "llm")) {
        expect(providers[name].status).toBe(defaults[name].status);
        expect(providers[name].configured).toBe(defaults[name].configured);
      }
      expect(Object.keys(providers)).toEqual([...PROVIDER_NAMES]);
      expect(PROVIDER_METHODS.asr).toEqual(["transcribe", "submit", "query"]);
      expect(PROVIDER_METHODS.llm).toEqual([
        "tagAsset",
        "extractKeyPoints",
        "summarizeAsset",
        "analyzeVision",
      ]);
      expect(h.asrClose).toHaveBeenCalledTimes(hasAsr ? 1 : 0);
      expect(h.llmClose).toHaveBeenCalledTimes(hasLlm ? 1 : 0);
      if (hasAsr && hasLlm) expect(closeOf(h, "asr")).not.toBe(closeOf(h, "llm"));
      expect(h.asrFetch).not.toHaveBeenCalled();
      expect(h.llmFetch).not.toHaveBeenCalled();
      expect(h.now).not.toHaveBeenCalled();
      expect(h.beforeCall).not.toHaveBeenCalled();
      expect(nativeFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "asr", half: "config" },
    { kind: "asr", half: "runtime" },
    { kind: "llm", half: "config" },
    { kind: "llm", half: "runtime" },
  ] as const)("$kind/$half 半配在所有环境拒绝且不登记", ({ kind, half }) => {
    for (const appEnv of PROVIDER_APP_ENVS) {
      const h = setup("both", appEnv);
      if (half === "config") delete h.options[kind];
      else delete h.options.settings![kind];
      expect(() => createProviders(h.options)).toThrow(ProviderConfigError);
      try {
        createProviders(h.options);
      } catch (error) {
        expect(error).toMatchObject({ name: "ProviderConfigError", provider: kind });
        expect(String(error)).not.toContain("PUBLIC_");
      }
      expect(h.asrClose).not.toHaveBeenCalled();
      expect(h.llmClose).not.toHaveBeenCalled();
      expect(h.asrFetch).not.toHaveBeenCalled();
      expect(h.llmFetch).not.toHaveBeenCalled();
      expect(h.logger.lines).toEqual([]);
    }
  });

  it.each([
    { kind: "asr", label: "null", runtime: null },
    { kind: "asr", label: "缺关闭登记", runtime: { now: () => fixedTime } },
    { kind: "asr", label: "缺时钟", runtime: { registerClose: () => {} } },
    {
      kind: "asr",
      label: "非法关闭登记",
      runtime: { now: () => fixedTime, registerClose: "private-value" },
    },
    { kind: "llm", label: "null", runtime: null },
    { kind: "llm", label: "非法关闭登记", runtime: { registerClose: "private-value" } },
  ] as const)("$kind/$label 运行依赖强转非法也不能回退", ({ kind, runtime }) => {
    const h = setup(kind);
    const options = { ...h.options, [kind]: runtime } as unknown as CreateProvidersOptions;
    expect(() => createProviders(options)).toThrow(ProviderConfigError);
    expect(() => createProviders(options)).not.toThrow("private-value");
    expect(h.asrFetch).not.toHaveBeenCalled();
    expect(h.llmFetch).not.toHaveBeenCalled();
    expect(h.logger.lines).toEqual([]);
  });

  it.each([
    { kind: "asr", invalid: "credentials" },
    { kind: "asr", invalid: "timeout" },
    { kind: "llm", invalid: "destination" },
    { kind: "llm", invalid: "timeout" },
  ] as const)("$kind/$invalid 继续委托原constructor拒绝", ({ kind, invalid }) => {
    const h = setup(kind);
    if (kind === "asr") {
      if (invalid === "credentials") h.options.settings!.asr!.secretId = "private-invalid/value";
      else h.options.asr!.timeoutMs = 10001;
    } else if (invalid === "destination")
      h.options.settings!.llm!.text.primary.workspaceId = "private-invalid/value";
    else h.options.llm!.totalTimeoutMs = 60001;
    expect(() => createProviders(h.options)).toThrow(TypeError);
    expect(() => createProviders(h.options)).not.toThrow("private-invalid/value");
    expect(h.asrClose).not.toHaveBeenCalled();
    expect(h.llmClose).not.toHaveBeenCalled();
    expect(h.asrFetch).not.toHaveBeenCalled();
    expect(h.llmFetch).not.toHaveBeenCalled();
  });

  it("完整模型配置只打印原十二项状态和汇总，不泄露参数", () => {
    const h = setup();
    const providers = createProviders(h.options);
    expect(h.logger.lines).toHaveLength(13);
    expect(h.logger.lines.slice(0, 12).map((line) => line.fields)).toEqual(
      describeProviders(providers).map(({ name, status }) => ({ provider: name, status })),
    );
    expect(h.logger.lines[12]).toMatchObject({ message: "providers ready" });
    const logs = JSON.stringify(h.logger.lines);
    for (const privateValue of [
      ...Object.values(asrConfig),
      "text-primary",
      "vision-primary",
      "vision-space",
      "PUBLIC_",
      "api.deepseek.com",
      "volces.com",
      "aliyuncs.com",
      audio,
    ])
      expect(logs).not.toContain(privateValue);
  });
});

const methods: ProviderCall[] = [
  { provider: "asr", method: "transcribe" },
  { provider: "asr", method: "submit" },
  { provider: "asr", method: "query" },
  { provider: "llm", method: "tagAsset" },
  { provider: "llm", method: "extractKeyPoints" },
  { provider: "llm", method: "summarizeAsset" },
  { provider: "llm", method: "analyzeVision" },
];
describe("真实模型经过唯一工厂外呼守卫", () => {
  it.each(methods)("$provider / $method 每入口仅一次", async ({ provider, method }) => {
    const h = setup();
    const providers = createProviders(h.options);
    const result = await callWithSample(providers, provider, method);
    expect(h.beforeCall.mock.calls).toEqual([[{ provider, method }]]);
    if (method === "transcribe") expect(result).toMatchObject({ ok: false, reason: "unsupported" });
    else expect(result.ok).toBe(true);
    expect(h.asrFetch.mock.calls.length + h.llmFetch.mock.calls.length).toBe(
      method === "transcribe" ? 0 : 1,
    );
    if (provider === "llm") {
      const visual = method === "tagAsset" || method === "analyzeVision";
      expect(h.llmSent[0]?.url).toBe(
        visual
          ? "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
          : "https://api.deepseek.com/chat/completions",
      );
      expect(JSON.parse(h.llmSent[0]!.body).model).toBe(visual ? "vision-primary" : "text-primary");
      expect(h.llmSent[0]?.headers.get("authorization")).toBe(
        visual ? "Bearer PUBLIC_VISION_PRIMARY" : "Bearer PUBLIC_TEXT_PRIMARY",
      );
    }
  });

  it.each(methods)(
    "$provider / $method 守卫原错先于校验/签名/HTTP",
    async ({ provider, method }) => {
      const h = setup();
      const sentinel = new Error("真实外呼前钩子拒绝");
      h.beforeCall.mockImplementation(() => {
        throw sentinel;
      });
      const providers = createProviders(h.options);
      await expect(callWithSample(providers, provider, method)).rejects.toBe(sentinel);
      expect(h.beforeCall.mock.calls).toEqual([[{ provider, method }]]);
      expect(h.now).not.toHaveBeenCalled();
      expect(h.asrFetch).not.toHaveBeenCalled();
      expect(h.llmFetch).not.toHaveBeenCalled();
    },
  );

  it("ASR原now与fetch透传，submit→query保无损任务号，旧同步方法不转成功", async () => {
    const h = setup("asr");
    const providers = createProviders(h.options);
    expect(await providers.asr.transcribe({ url: audio })).toMatchObject({
      ok: false,
      reason: "unsupported",
    });
    expect(await providers.asr.submit({ url: audio })).toEqual({
      ok: true,
      value: { taskId, requestId: "request-submit" },
    });
    expect(await providers.asr.query({ taskId })).toMatchObject({
      ok: true,
      value: { state: "succeeded", text: "公开虚构转写", durationSec: 1.2 },
    });
    expect(h.asrSent.map((r) => r.url)).toEqual([
      "https://asr.tencentcloudapi.com/",
      "https://asr.tencentcloudapi.com/",
    ]);
    expect(h.asrSent.map((r) => r.headers.get("x-tc-action"))).toEqual([
      "CreateRecTask",
      "DescribeTaskStatus",
    ]);
    expect(h.asrSent[1]?.body).toBe(`{"TaskId":${taskId}}`);
    expect(h.asrSent[0]?.headers.get("x-tc-timestamp")).toBe(String(fixedTime.getTime() / 1000));
    expect(h.now).toHaveBeenCalledTimes(2);
    expect(h.llmFetch).not.toHaveBeenCalled();
  });

  it("LLM经工厂主错→修错→备方成功，原整次3请求只调一次守卫", async () => {
    const h = setup("llm");
    h.options.llm!.timeoutMs = 100;
    h.options.llm!.totalTimeoutMs = 300;
    h.llmFetch
      .mockResolvedValueOnce(chat({ wrong: true }))
      .mockResolvedValueOnce(chat({ wrong: true }));
    const providers = createProviders(h.options);
    expect(await providers.llm.extractKeyPoints({ text: "公开虚构牛肉面" })).toEqual({
      ok: true,
      value: { points: ["牛肉面"] },
    });
    expect(h.llmFetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.deepseek.com/chat/completions",
      "https://api.deepseek.com/chat/completions",
      "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    ]);
    expect(h.beforeCall.mock.calls).toEqual([[{ provider: "llm", method: "extractKeyPoints" }]]);
    expect(h.asrFetch).not.toHaveBeenCalled();
  });
});

describe("模型驱动原生命周期与DI隔离", () => {
  it.each(["asr", "llm"] as const)(
    "%s close登记的是实际驱动关闭且等待自己的在途请求",
    async (kind) => {
      const h = setup(kind);
      const blocking = blockingTransport();
      if (kind === "asr") h.options.asr!.fetch = blocking.transport;
      else h.options.llm!.fetch = blocking.transport;
      const providers = createProviders(h.options);
      const call =
        kind === "asr"
          ? providers.asr.submit({ url: audio })
          : providers.llm.extractKeyPoints({ text: "公开虚构菜单" });
      const running = Promise.allSettled([call]);
      const signal = await blocking.entered.promise;
      const close = closeOf(h, kind);
      const closing = close();
      const again = close();
      let settled = false;
      void closing.then(() => {
        settled = true;
      });
      try {
        await blocking.aborted.promise;
        expect(signal.aborted).toBe(true);
        // ASR须等注入传输释放；LLM原abortable可先结束，不能篡改两种原协议。
        if (kind === "asr") expect(settled).toBe(false);
        expect(again).toBe(closing);
      } finally {
        blocking.release.resolve();
        await Promise.all([running, closing, again]);
      }
      expect(await call).toMatchObject({ ok: false, reason: "unavailable" });
      const calls = blocking.transport.mock.calls.length;
      const late =
        kind === "asr"
          ? providers.asr.submit({ url: audio })
          : providers.llm.extractKeyPoints({ text: "公开虚构菜单" });
      expect(await late).toMatchObject({ ok: false, reason: "unavailable" });
      expect(blocking.transport).toHaveBeenCalledTimes(calls);
    },
  );

  it("关一个ASR不关同工厂LLM或另一个工厂实例，不关借用fetch", async () => {
    const a = setup();
    const b = setup();
    const borrowedClose = vi.fn();
    Object.assign(a.asrFetch, { close: borrowedClose });
    b.options.asr!.fetch = a.asrFetch;
    const first = createProviders(a.options);
    const second = createProviders(b.options);
    await closeOf(a, "asr")();
    expect(await first.asr.submit({ url: audio })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(await first.llm.extractKeyPoints({ text: "公开虚构菜单" })).toMatchObject({ ok: true });
    expect(await second.asr.submit({ url: audio })).toMatchObject({ ok: true });
    expect(await second.llm.extractKeyPoints({ text: "公开虚构菜单" })).toMatchObject({ ok: true });
    expect(a.asrFetch).toHaveBeenCalledTimes(1);
    expect(a.llmFetch).toHaveBeenCalledTimes(1);
    expect(b.asrFetch).not.toHaveBeenCalled();
    expect(b.llmFetch).toHaveBeenCalledTimes(1);
    expect(closeOf(a, "asr")).not.toBe(closeOf(b, "asr"));
    expect(closeOf(a, "llm")).not.toBe(closeOf(b, "llm"));
    expect(borrowedClose).not.toHaveBeenCalled();
  });

  it("LLM close有界消费不合作fetch的迟到拒绝，caller信号不被改写", async () => {
    const h = setup("llm");
    const entered = deferred();
    const late = deferred<Response>();
    const rejected: unknown[] = [];
    const unhandled = (reason: unknown) => {
      rejected.push(reason);
    };
    process.on("unhandledRejection", unhandled);
    h.llmFetch.mockImplementation(() => {
      entered.resolve();
      return late.promise;
    });
    const controller = new AbortController();
    const providers = createProviders(h.options);
    const call = providers.llm.analyzeVision({
      imageUrls: ["https://example.invalid/image.jpg"],
      signal: controller.signal,
    });
    const running = Promise.allSettled([call]);
    try {
      await entered.promise;
      await closeOf(h, "llm")();
      expect(await call).toMatchObject({ ok: false, reason: "unavailable" });
      expect(controller.signal.aborted).toBe(false);
      late.reject(new Error("公开虚构迟到错误"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rejected).toEqual([]);
      expect(h.llmFetch).toHaveBeenCalledTimes(1);
    } finally {
      late.reject(new Error("清理迟到传输"));
      await running;
      process.off("unhandledRejection", unhandled);
    }
  });

  it("第二配置失败不伪造工厂成功，第一实际close已登记供装配失败关闭", async () => {
    const h = setup();
    h.options.settings!.llm!.vision.primary.model = "invalid/model";
    expect(() => createProviders(h.options)).toThrow(TypeError);
    expect(h.asrClose).toHaveBeenCalledTimes(1);
    expect(h.llmClose).not.toHaveBeenCalled();
    expect(h.logger.lines).toEqual([]);
    await expect(closeOf(h, "asr")()).resolves.toBeUndefined();
    expect(h.asrFetch).not.toHaveBeenCalled();
    expect(h.llmFetch).not.toHaveBeenCalled();
  });

  it("关闭登记本身失败原样传播，不返回成功或吞装配错误", () => {
    const h = setup("asr");
    const sentinel = new Error("关闭登记故障");
    h.asrClose.mockImplementation((close) => {
      owned.add(close);
      throw sentinel;
    });
    expect(() => createProviders(h.options)).toThrow(sentinel);
    expect(h.asrClose).toHaveBeenCalledTimes(1);
    expect(h.logger.lines).toEqual([]);
    expect(h.asrFetch).not.toHaveBeenCalled();
    expect(h.llmFetch).not.toHaveBeenCalled();
  });
});
