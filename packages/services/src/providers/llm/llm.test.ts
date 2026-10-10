import { createServer } from "node:http";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeLlm, createRecordingLogger } from "../../testing/index.js";
import { createProviders } from "../index.js";
import { withBeforeCall } from "../types.js";
import type { LlmProvider, ProviderFailureReason, ProviderResult } from "../types.js";
import type { DomesticLlmConfig, DomesticLlmOptions, LlmEndpoint } from "./driver.js";
import { createDomesticLlm } from "./driver.js";

// 全部凭据和素材为公开虚构值。固定官方目的地只转发本机 HTTP，不调用模型服务。
const nativeFetch = globalThis.fetch;
const privateText = "待归纳的内部菜单：招牌牛肉面，每天现熬汤底。";
const privateUrl = "https://assets.example.invalid/menu.jpg?signature=private-media-token";
const points = { points: ["招牌牛肉面", "每天现熬汤底"] };
const tags = { description: "一碗牛肉面与菜单", tags: ["餐饮", "牛肉面"] };
const textPrimaryUrl = "https://api.deepseek.com/chat/completions";
const textBackupUrl = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const visionBackupUrl =
  "https://vision-space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions";

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

type Owned = ReturnType<typeof createDomesticLlm>;
type TagInput = Parameters<LlmProvider["tagAsset"]>[0];
type PointsInput = Parameters<LlmProvider["extractKeyPoints"]>[0];
type Message = {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
};
type ChatBody = { model: string; stream: boolean; response_format: unknown; messages: Message[] };
type Sent = { url: string; init: RequestInit; headers: Headers; body: ChatBody };
type Received = { headers: IncomingHttpHeaders; body: ChatBody; method?: string; path?: string };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assistant(
  content: unknown,
  fields: Record<string, unknown> = {},
  finish: unknown = "stop",
) {
  return {
    choices: [
      { index: 0, finish_reason: finish, message: { role: "assistant", content, ...fields } },
    ],
  };
}

function chat(value: unknown) {
  return assistant(JSON.stringify(value));
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function safeFailure(result: ProviderResult<unknown>, reason?: ProviderFailureReason) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("不应成功");
  expect(Object.keys(result).sort()).toEqual(["message", "ok", "reason"]);
  if (reason) expect(result.reason).toBe(reason);
  expect(result.message.length).toBeGreaterThan(0);
  const rendered = JSON.stringify(result);
  for (const forbidden of [
    privateText,
    privateUrl,
    "private-media-token",
    "vendor-raw-sensitive",
    "raw-response-sensitive",
    ...Object.values(configuration()).flatMap((role) => [role.primary.apiKey, role.backup.apiKey]),
    textPrimaryUrl,
    textBackupUrl,
    visionBackupUrl,
  ])
    expect(rendered).not.toContain(forbidden);
  return result;
}

function expectModels(sent: Sent[], models: string[]) {
  expect(sent.map((request) => request.body.model)).toEqual(models);
  expect(sent.length).toBeLessThanOrEqual(3);
}

async function withHttp(
  reply: (request: Received, response: ServerResponse, index: number) => unknown,
  run: (http: {
    sent: Sent[];
    received: Received[];
    fetch: typeof fetch;
    create(config?: DomesticLlmConfig, options?: DomesticLlmOptions): Owned;
  }) => Promise<void>,
) {
  const sent: Sent[] = [];
  const received: Received[] = [];
  const errors: unknown[] = [];
  const owned: Owned[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const record: Received = {
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatBody,
        method: request.method,
        path: request.url,
      };
      received.push(record);
      await reply(record, response, received.length - 1);
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("本地协议服务未就绪");
  const forwarding: typeof fetch = (target, init) => {
    const url = String(target);
    if (!init || typeof init.body !== "string") throw new Error("协议请求应使用 JSON 字符串");
    sent.push({
      url,
      init,
      headers: new Headers(init.headers),
      body: JSON.parse(init.body) as ChatBody,
    });
    return nativeFetch(`http://127.0.0.1:${address.port}/chat`, init);
  };
  try {
    await run({
      sent,
      received,
      fetch: forwarding,
      create(config = configuration(), options = {}) {
        const scope = createDomesticLlm(config, { ...options, fetch: options.fetch ?? forwarding });
        owned.push(scope);
        return scope;
      },
    });
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(owned.map((scope) => scope.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("国内 LLM：固定兼容端点与旧接口", () => {
  it.each([
    { vendor: "ark", url: textBackupUrl },
    {
      vendor: "bailian",
      url: "https://menu-space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    },
    { vendor: "deepseek", url: textPrimaryUrl },
  ] as const)("$vendor 使用固定路径、显式模型与 JSON 请求", async ({ vendor, url }) => {
    await withHttp(
      (_request, response) => json(response, chat(points)),
      async (http) => {
        const config = configuration();
        config.text.primary = {
          vendor,
          model: "configured-model.v1:menu",
          apiKey: "PUBLIC_FIXED_KEY",
          ...(vendor === "bailian" ? { workspaceId: "menu-space" } : {}),
        };
        const scope = http.create(config);
        expect(scope.provider.status).toBe("domestic-llm");
        expect(scope.provider.configured).toBe(true);
        expect(
          Object.keys(scope.provider)
            .filter((key) => typeof Reflect.get(scope.provider, key) === "function")
            .sort(),
        ).toEqual(["extractKeyPoints", "tagAsset"]);
        expect(await scope.provider.extractKeyPoints({ text: privateText, maxPoints: 2 })).toEqual({
          ok: true,
          value: points,
        });
        expect(http.sent).toHaveLength(1);
        const request = http.sent[0]!;
        expect(request.url).toBe(url);
        expect(request.init.method).toBe("POST");
        expect(request.init.redirect).toBe("error");
        expect(request.headers.get("authorization")).toBe("Bearer PUBLIC_FIXED_KEY");
        expect(request.headers.get("content-type")).toMatch(/^application\/json(?:;|$)/i);
        expect(request.body).toMatchObject({
          model: "configured-model.v1:menu",
          stream: false,
          response_format: { type: "json_object" },
        });
        expect(
          request.body.messages.some(
            (message) => message.role === "system" && /json/i.test(JSON.stringify(message.content)),
          ),
        ).toBe(true);
        expect(JSON.stringify(request.body.messages)).toContain(privateText);
        expect(JSON.stringify(request.body.messages)).toContain("points");
        expect(http.received[0]!.body).toEqual(request.body);
        expect(http.received[0]!.method).toBe("POST");
        expect(http.received[0]!.path).toBe("/chat");
      },
    );
  });

  it("图片只走 vision，URL 是 image_url 内容，驱动不下载素材", async () => {
    await withHttp(
      (_request, response) => json(response, chat(tags)),
      async (http) => {
        expect(
          await http
            .create()
            .provider.tagAsset({ kind: "image", url: privateUrl, text: privateText }),
        ).toEqual({ ok: true, value: tags });
        expectModels(http.sent, ["vision-primary"]);
        expect(http.sent[0]!.url).toBe(textBackupUrl);
        expect(http.sent[0]!.headers.get("authorization")).toBe("Bearer PUBLIC_VISION_PRIMARY");
        const parts = http.sent[0]!.body.messages.flatMap((message) =>
          typeof message.content === "string" ? [] : message.content,
        );
        expect(parts).toContainEqual({ type: "image_url", image_url: { url: privateUrl } });
        expect(JSON.stringify(http.sent[0]!.body.messages)).toContain("description");
        expect(JSON.stringify(http.sent[0]!.body.messages)).toContain("tags");
        expect(JSON.stringify(http.sent[0]!.body.messages)).not.toContain(privateText);
      },
    );
  });

  it.each(["audio", "document", "video"] as const)("%s 的已有文本只走 text", async (kind) => {
    await withHttp(
      (_request, response) => json(response, chat(tags)),
      async (http) => {
        expect(await http.create().provider.tagAsset({ kind, text: privateText })).toEqual({
          ok: true,
          value: tags,
        });
        expectModels(http.sent, ["text-primary"]);
        expect(http.sent[0]!.url).toBe(textPrimaryUrl);
        expect(http.sent[0]!.headers.get("authorization")).toBe("Bearer PUBLIC_TEXT_PRIMARY");
        expect(JSON.stringify(http.sent[0]!.body.messages)).toContain(privateText);
        expect(JSON.stringify(http.sent[0]!.body.messages)).not.toContain("image_url");
      },
    );
  });

  it("只有视频 URL 时受控 unsupported，不冒充图片或外呼", async () => {
    await withHttp(
      (_request, response) => json(response, chat(tags)),
      async (http) => {
        safeFailure(
          await http.create().provider.tagAsset({ kind: "video", url: privateUrl }),
          "unsupported",
        );
        expect(http.sent).toEqual([]);
      },
    );
  });

  it("缺省 maxPoints 为3，成功立即结束，不使用备方", async () => {
    const value = { points: ["牛肉面", "现熬汤", "堂食"] };
    await withHttp(
      (_request, response) => json(response, chat(value)),
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value,
        });
        expectModels(http.sent, ["text-primary"]);
      },
    );
  });

  it("text 与 vision 的备方各自独立，成功不会改动下一调用的主方", async () => {
    await withHttp(
      (request, response) => {
        if (request.body.model.endsWith("primary"))
          json(response, { error: "vendor-raw-sensitive" }, 503);
        else json(response, chat(request.body.model === "vision-backup" ? tags : points));
      },
      async (http) => {
        const scope = http.create();
        expect(await scope.provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expect(await scope.provider.tagAsset({ kind: "image", url: privateUrl })).toEqual({
          ok: true,
          value: tags,
        });
        expect(await scope.provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expect(http.sent.map((request) => request.body.model)).toEqual([
          "text-primary",
          "text-backup",
          "vision-primary",
          "vision-backup",
          "text-primary",
          "text-backup",
        ]);
        expect(http.sent.map((request) => request.url)).toEqual([
          textPrimaryUrl,
          textBackupUrl,
          textBackupUrl,
          visionBackupUrl,
          textPrimaryUrl,
          textBackupUrl,
        ]);
        expect(http.sent[3]!.headers.get("authorization")).toBe("Bearer PUBLIC_VISION_BACKUP");
      },
    );
  });
});

describe("国内 LLM：有界切备和一次 schema 修复", () => {
  it.each([408, 429, 500, 502, 503, 599])("HTTP %i 仅切备一次", async (status) => {
    await withHttp(
      (_request, response, index) =>
        index === 0
          ? json(response, { error: `vendor-raw-sensitive-${privateText}` }, status)
          : json(response, chat(points)),
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary", "text-backup"]);
      },
    );
  });

  it("真实 HTTP 连接中断后只切一次备方", async () => {
    await withHttp(
      (_request, response, index) =>
        index === 0 ? response.destroy() : json(response, chat(points)),
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary", "text-backup"]);
      },
    );
  });

  it.each([400, 401, 403, 404, 409, 422])(
    "HTTP %i 明确拒绝，不切备或按错误文案重试",
    async (status) => {
      await withHttp(
        (_request, response) =>
          json(response, { error: `retry please vendor-raw-sensitive ${privateText}` }, status),
        async (http) => {
          safeFailure(
            await http.create().provider.extractKeyPoints({ text: privateText }),
            "rejected",
          );
          expectModels(http.sent, ["text-primary"]);
        },
      );
    },
  );

  it("重定向拒绝且不跟随 Location，备方仍使用固定目的地", async () => {
    await withHttp(
      (_request, response, index) => {
        if (index === 0) {
          response.writeHead(302, { location: "https://foreign.example.invalid/steal" });
          response.end();
        } else json(response, chat(points));
      },
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary", "text-backup"]);
        expect(http.sent.every((request) => request.init.redirect === "error")).toBe(true);
      },
    );
  });

  it("主方 schema 错后原主方修复一次；修复不回送原始模型正文", async () => {
    await withHttp(
      (_request, response, index) =>
        json(response, chat(index === 0 ? { points: "raw-response-sensitive" } : points)),
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary", "text-primary"]);
        expect(http.sent[1]!.body.messages).not.toEqual(http.sent[0]!.body.messages);
        expect(JSON.stringify(http.sent[1]!.body.messages)).toContain(privateText);
        expect(JSON.stringify(http.sent[1]!.body)).not.toContain("raw-response-sensitive");
        expect(JSON.stringify(http.sent[1]!.body)).toContain("points");
      },
    );
  });

  it("主错→主修错→备好恰为3次，不再为备方增加修复", async () => {
    await withHttp(
      (_request, response, index) =>
        json(response, chat(index < 2 ? { points: "raw-response-sensitive" } : points)),
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary", "text-primary", "text-backup"]);
        for (const request of http.sent)
          expect(JSON.stringify(request.body)).not.toContain("raw-response-sensitive");
      },
    );
  });

  it("主5xx→备错→备修好恰为3次，修复额度属于整次调用", async () => {
    await withHttp(
      (_request, response, index) =>
        index === 0
          ? json(response, { error: "vendor-raw-sensitive" }, 503)
          : json(response, chat(index === 1 ? { points: [] } : points)),
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary", "text-backup", "text-backup"]);
      },
    );
  });

  it("两方都错 schema 到3次停止，不递归切换", async () => {
    await withHttp(
      (_request, response) => json(response, chat({ points: "raw-response-sensitive" })),
      async (http) => {
        safeFailure(
          await http.create().provider.extractKeyPoints({ text: privateText }),
          "unavailable",
        );
        expectModels(http.sent, ["text-primary", "text-primary", "text-backup"]);
      },
    );
  });

  it("主、备都5xx到2次停止，无第三次网络重试", async () => {
    await withHttp(
      (_request, response) => json(response, { error: "vendor-raw-sensitive" }, 503),
      async (http) => {
        safeFailure(
          await http.create().provider.extractKeyPoints({ text: privateText }),
          "unavailable",
        );
        expectModels(http.sent, ["text-primary", "text-backup"]);
      },
    );
  });

  it("主方 schema 错后的修复遇到明确拒绝即结束，不切备", async () => {
    await withHttp(
      (_request, response, index) =>
        index === 0
          ? json(response, chat({ points: [] }))
          : json(response, { error: "vendor-raw-sensitive" }, 403),
      async (http) => {
        safeFailure(
          await http.create().provider.extractKeyPoints({ text: privateText }),
          "rejected",
        );
        expectModels(http.sent, ["text-primary", "text-primary"]);
      },
    );
  });
});

describe("国内 LLM：严格响应协议", () => {
  const badEnvelopes: Array<{ label: string; value: unknown }> = [
    { label: "缺 choices", value: {} },
    { label: "空 choices", value: { choices: [] } },
    {
      label: "多个 choices",
      value: { choices: [chat(points).choices[0], chat(points).choices[0]] },
    },
    { label: "缺 message", value: { choices: [{ finish_reason: "stop" }] } },
    { label: "非 assistant", value: assistant(JSON.stringify(points), { role: "user" }) },
    { label: "缺 content", value: assistant(undefined) },
    { label: "content 非字符串", value: assistant([points]) },
    {
      label: "缺 finish_reason",
      value: { choices: [{ message: { role: "assistant", content: JSON.stringify(points) } }] },
    },
    { label: "length 截断", value: assistant(JSON.stringify(points), {}, "length") },
    { label: "顶层不是对象", value: [] },
  ];
  it.each(badEnvelopes)("$label 不造成功，可按协议失败切备", async ({ value }) => {
    await withHttp(
      (_request, response, index) => json(response, index === 0 ? value : chat(points)),
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary", "text-backup"]);
      },
    );
  });

  it.each([
    { refusal: `vendor-raw-sensitive ${privateText}` },
    { tool_calls: [{ id: "private-tool", type: "function" }] },
    { function_call: { name: "private-tool" } },
  ])("模型明确拒绝或工具调用 %j 不修复、不切备", async (fields) => {
    await withHttp(
      (_request, response) => json(response, assistant(JSON.stringify(points), fields)),
      async (http) => {
        safeFailure(
          await http.create().provider.extractKeyPoints({ text: privateText }),
          "rejected",
        );
        expectModels(http.sent, ["text-primary"]);
      },
    );
  });

  it("外层损坏 JSON 切备，不把原正文传给修复或错误结果", async () => {
    await withHttp(
      (_request, response, index) =>
        index === 0 ? response.end("{raw-response-sensitive") : json(response, chat(points)),
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary", "text-backup"]);
        expect(JSON.stringify(http.sent[1]!.body)).not.toContain("raw-response-sensitive");
      },
    );
  });

  it("坏 UTF-8 不用替换字符生成业务成功", async () => {
    await withHttp(
      (_request, response, index) => {
        if (index === 0) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            Buffer.concat([
              Buffer.from(
                '{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"{\\"points\\":[\\"',
              ),
              Buffer.from([0xc3, 0x28]),
              Buffer.from('\\"]}"}}]}'),
            ]),
          );
        } else json(response, chat(points));
      },
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary", "text-backup"]);
      },
    );
  });

  it("无 Content-Length 的分块响应超1MiB立即拒绝，仍受一次切备限制", async () => {
    await withHttp(
      (_request, response, index) => {
        if (index === 0) {
          response.writeHead(200, { "content-type": "application/json" });
          for (let chunk = 0; chunk < 17; chunk++) response.write(" ".repeat(64 * 1024));
          response.end();
        } else json(response, chat(points));
      },
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary", "text-backup"]);
      },
    );
  });

  it("响应大小恰1MiB可成功；计数包含外层 JSON 与前导空白", async () => {
    const body = JSON.stringify(chat(points));
    const padded = " ".repeat(1024 * 1024 - Buffer.byteLength(body)) + body;
    await withHttp(
      (_request, response) => response.end(padded),
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary"]);
      },
    );
  });

  it.each([
    { label: "markdown 包裹", content: '```json\n{"points":["面"]}\n```' },
    { label: "非 JSON", content: "raw-response-sensitive" },
    { label: "JSON 后附正文", content: '{"points":["面"]} raw-response-sensitive' },
  ])("内层 $label 只能修复一次，不宽松提取 JSON", async ({ content }) => {
    await withHttp(
      (_request, response) => json(response, assistant(content)),
      async (http) => {
        safeFailure(
          await http.create().provider.extractKeyPoints({ text: privateText }),
          "unavailable",
        );
        expectModels(http.sent, ["text-primary", "text-primary", "text-backup"]);
        for (const request of http.sent)
          expect(JSON.stringify(request.body)).not.toContain("raw-response-sensitive");
      },
    );
  });
});

describe("国内 LLM：输入与业务输出边界", () => {
  it.each([
    { label: "空文本", input: { text: "" } },
    { label: "空白文本", input: { text: " \n\t" } },
    { label: "文本缺失", input: {} },
    { label: "文本类型错误", input: { text: 12 } },
    { label: "ASCII 超64KiB", input: { text: "a".repeat(65537) } },
    { label: "UTF8 超64KiB", input: { text: "中".repeat(21846) } },
    { label: "maxPoints 为0", input: { text: privateText, maxPoints: 0 } },
    { label: "maxPoints 为21", input: { text: privateText, maxPoints: 21 } },
    { label: "maxPoints 小数", input: { text: privateText, maxPoints: 1.5 } },
    { label: "maxPoints 为NaN", input: { text: privateText, maxPoints: Number.NaN } },
    {
      label: "maxPoints 为Infinity",
      input: { text: privateText, maxPoints: Number.POSITIVE_INFINITY },
    },
    { label: "maxPoints 类型错误", input: { text: privateText, maxPoints: "3" } },
  ])("$label 在 HTTP 前拒绝", async ({ input }) => {
    await withHttp(
      (_request, response) => json(response, chat(points)),
      async (http) => {
        safeFailure(
          await http.create().provider.extractKeyPoints(input as PointsInput),
          "rejected",
        );
        expect(http.sent).toEqual([]);
      },
    );
  });

  it.each([
    { label: "ASCII 恰64KiB", text: "a".repeat(65536) },
    { label: "多字节恰64KiB", text: "中".repeat(21845) + "a" },
  ])("$label 可外呼", async ({ text }) => {
    await withHttp(
      (_request, response) => json(response, chat({ points: ["菜单"] })),
      async (http) => {
        expect(await http.create().provider.extractKeyPoints({ text, maxPoints: 1 })).toEqual({
          ok: true,
          value: { points: ["菜单"] },
        });
        expectModels(http.sent, ["text-primary"]);
        expect(JSON.stringify(http.sent[0]!.body.messages)).toContain(text);
      },
    );
  });

  it.each([
    {
      label: "HTTP 图片 URL",
      input: { kind: "image", url: "http://assets.example.invalid/a.jpg" },
    },
    {
      label: "URL 带用户名",
      input: { kind: "image", url: "https://user@assets.example.invalid/a.jpg" },
    },
    {
      label: "URL 带密码",
      input: { kind: "image", url: "https://user:pass@assets.example.invalid/a.jpg" },
    },
    {
      label: "URL 带 fragment",
      input: { kind: "image", url: "https://assets.example.invalid/a.jpg#private" },
    },
    { label: "URL 无效", input: { kind: "image", url: "private-media-token" } },
    { label: "URL 类型错误", input: { kind: "image", url: 1 } },
    { label: "图片缺 URL", input: { kind: "image" } },
    { label: "audio 缺文本", input: { kind: "audio", url: privateUrl } },
    { label: "document 空白文本", input: { kind: "document", text: "\n " } },
    { label: "audio 文本超限", input: { kind: "audio", text: "中".repeat(21846) } },
    { label: "不存在 kind", input: { kind: "other", text: privateText } },
  ])("$label 在 HTTP 前拒绝", async ({ input }) => {
    await withHttp(
      (_request, response) => json(response, chat(tags)),
      async (http) => {
        safeFailure(await http.create().provider.tagAsset(input as TagInput), "rejected");
        expect(http.sent).toEqual([]);
      },
    );
  });

  it.each([
    { length: 8192, accepted: true },
    { length: 8193, accepted: false },
  ])("图片 URL 长度$length 的8KiB边界", async ({ length, accepted }) => {
    const prefix = "https://assets.example.invalid/";
    const url = prefix + "a".repeat(length - prefix.length);
    await withHttp(
      (_request, response) => json(response, chat(tags)),
      async (http) => {
        const result = await http.create().provider.tagAsset({ kind: "image", url });
        if (accepted) expect(result).toEqual({ ok: true, value: tags });
        else safeFailure(result, "rejected");
        expect(http.sent).toHaveLength(accepted ? 1 : 0);
      },
    );
  });

  it.each([
    { label: "description 缺失", value: { tags: [] } },
    { label: "description 空", value: { description: "", tags: [] } },
    { label: "description 纯空白", value: { description: " \n", tags: [] } },
    { label: "description 超2000", value: { description: "面".repeat(2001), tags: [] } },
    { label: "description 类型错误", value: { description: 1, tags: [] } },
    { label: "tags 缺失", value: { description: "牛肉面" } },
    { label: "tags 不是数组", value: { description: "牛肉面", tags: "面" } },
    {
      label: "tags 超20项",
      value: {
        description: "牛肉面",
        tags: Array.from({ length: 21 }, (_, index) => `标签${index}`),
      },
    },
    { label: "tag 为空", value: { description: "牛肉面", tags: [""] } },
    { label: "tag 纯空白", value: { description: "牛肉面", tags: ["\t "] } },
    { label: "tag 超100", value: { description: "牛肉面", tags: ["面".repeat(101)] } },
    { label: "tag 类型错误", value: { description: "牛肉面", tags: [1] } },
    { label: "额外业务字段", value: { ...tags, private_field: "raw-response-sensitive" } },
    { label: "业务数组", value: [tags] },
  ])("tagAsset $label 不成为成功", async ({ value }) => {
    await withHttp(
      (_request, response) => json(response, chat(value)),
      async (http) => {
        safeFailure(
          await http.create().provider.tagAsset({ kind: "image", url: privateUrl }),
          "unavailable",
        );
        expectModels(http.sent, ["vision-primary", "vision-primary", "vision-backup"]);
      },
    );
  });

  it.each([
    { label: "缺 points", value: {} },
    { label: "points 不是数组", value: { points: "raw-response-sensitive" } },
    { label: "points 为空", value: { points: [] } },
    { label: "point 为空", value: { points: [""] } },
    { label: "point 纯空白", value: { points: [" \n"] } },
    { label: "point 超500", value: { points: ["面".repeat(501)] } },
    { label: "point 类型错误", value: { points: [1] } },
    { label: "points 超 maxPoints", value: { points: ["一", "二", "三"] } },
    { label: "额外业务字段", value: { ...points, description: "raw-response-sensitive" } },
    { label: "业务 null", value: null },
  ])("extractKeyPoints $label 不成为成功", async ({ value }) => {
    await withHttp(
      (_request, response) => json(response, chat(value)),
      async (http) => {
        safeFailure(
          await http.create().provider.extractKeyPoints({ text: privateText, maxPoints: 2 }),
          "unavailable",
        );
        expectModels(http.sent, ["text-primary", "text-primary", "text-backup"]);
      },
    );
  });

  it("description2000、20个tag各100字符与空tags均可成功", async () => {
    const boundary = {
      description: "面".repeat(2000),
      tags: Array.from({ length: 20 }, () => "餐".repeat(100)),
    };
    await withHttp(
      (_request, response, index) =>
        json(response, chat(index === 0 ? boundary : { description: "菜单", tags: [] })),
      async (http) => {
        const scope = http.create();
        expect(await scope.provider.tagAsset({ kind: "image", url: privateUrl })).toEqual({
          ok: true,
          value: boundary,
        });
        expect(await scope.provider.tagAsset({ kind: "image", url: privateUrl })).toEqual({
          ok: true,
          value: { description: "菜单", tags: [] },
        });
        expectModels(http.sent, ["vision-primary", "vision-primary"]);
      },
    );
  });

  it("20个point各500字符可成功，不截断或伪造缺省要点", async () => {
    const boundary = { points: Array.from({ length: 20 }, () => "面".repeat(500)) };
    await withHttp(
      (_request, response) => json(response, chat(boundary)),
      async (http) => {
        expect(
          await http.create().provider.extractKeyPoints({ text: privateText, maxPoints: 20 }),
        ).toEqual({ ok: true, value: boundary });
        expectModels(http.sent, ["text-primary"]);
      },
    );
  });
});

describe("国内 LLM：取消、期限与释放", () => {
  it("pre-abort 无 HTTP，也不创建备方请求", async () => {
    await withHttp(
      (_request, response) => json(response, chat(points)),
      async (http) => {
        const controller = new AbortController();
        controller.abort(new Error("vendor-raw-sensitive"));
        safeFailure(
          await http
            .create()
            .provider.extractKeyPoints({ text: privateText, signal: controller.signal }),
          "unavailable",
        );
        expect(http.sent).toEqual([]);
      },
    );
  });

  it("请求等待中 caller abort 取消自有 signal，监听 finally 解除", async () => {
    const arrived = deferred();
    await withHttp(
      () => {
        arrived.resolve();
      },
      async (http) => {
        const controller = new AbortController();
        const add = vi.spyOn(controller.signal, "addEventListener");
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        const pending = http
          .create()
          .provider.extractKeyPoints({ text: privateText, signal: controller.signal });
        await arrived.promise;
        expect(http.sent[0]!.init.signal).not.toBe(controller.signal);
        controller.abort(new Error(`vendor-raw-sensitive ${privateText}`));
        safeFailure(await pending, "unavailable");
        expectModels(http.sent, ["text-primary"]);
        expect(http.sent[0]!.init.signal?.aborted).toBe(true);
        const listeners = add.mock.calls.filter(([name]) => name === "abort");
        expect(listeners.length).toBeGreaterThan(0);
        for (const [, listener] of listeners)
          expect(
            remove.mock.calls.some(([name, removed]) => name === "abort" && removed === listener),
          ).toBe(true);
      },
    );
  });

  it("读取未完成响应时 caller abort 结束，不切备", async () => {
    const headers = deferred();
    await withHttp(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"choices":[');
      },
      async (http) => {
        const controller = new AbortController();
        const forwarding: typeof fetch = async (target, init) => {
          const response = await http.fetch(target, init);
          headers.resolve();
          return response;
        };
        const pending = http
          .create(configuration(), { fetch: forwarding })
          .provider.extractKeyPoints({ text: privateText, signal: controller.signal });
        await headers.promise;
        await Promise.resolve();
        controller.abort();
        safeFailure(await pending, "unavailable");
        expectModels(http.sent, ["text-primary"]);
      },
    );
  });

  it("单请求期限到点可切一次备方，期限覆盖等待响应", async () => {
    await withHttp(
      (_request, response, index) => {
        if (index > 0) json(response, chat(points));
      },
      async (http) => {
        const scope = http.create(configuration(), { timeoutMs: 40, totalTimeoutMs: 1000 });
        expect(await scope.provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expectModels(http.sent, ["text-primary", "text-backup"]);
        expect(http.sent[0]!.init.signal?.aborted).toBe(true);
      },
    );
  });

  it("单请求期限覆盖读流，不因已收到 headers 无限等待", async () => {
    await withHttp(
      (_request, response, index) => {
        if (index === 0) {
          response.writeHead(200);
          response.write('{"choices":[');
        } else json(response, chat(points));
      },
      async (http) => {
        expect(
          await http
            .create(configuration(), { timeoutMs: 40, totalTimeoutMs: 1000 })
            .provider.extractKeyPoints({ text: privateText }),
        ).toEqual({ ok: true, value: points });
        expectModels(http.sent, ["text-primary", "text-backup"]);
      },
    );
  });

  it("总期限到点不切备，单请求期限不能扩大整次预算", async () => {
    await withHttp(
      () => {},
      async (http) => {
        safeFailure(
          await http
            .create(configuration(), { timeoutMs: 1000, totalTimeoutMs: 40 })
            .provider.extractKeyPoints({ text: privateText }),
          "unavailable",
        );
        expectModels(http.sent, ["text-primary"]);
        expect(http.sent[0]!.init.signal?.aborted).toBe(true);
      },
    );
  });

  it("总期限覆盖 schema 修复，不随新请求重置", async () => {
    vi.useFakeTimers();
    const calls: Array<{ model: string; signal: AbortSignal | null | undefined }> = [];
    const repairing = deferred();
    const transport: typeof fetch = async (_target, init) => {
      const body = JSON.parse(String(init?.body)) as ChatBody;
      calls.push({ model: body.model, signal: init?.signal });
      if (calls.length === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        return new Response(JSON.stringify(chat({ points: [] })));
      }
      repairing.resolve();
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("vendor-raw-sensitive")), {
          once: true,
        }),
      );
    };
    const scope = createDomesticLlm(configuration(), {
      fetch: transport,
      timeoutMs: 100,
      totalTimeoutMs: 50,
    });
    try {
      const pending = scope.provider.extractKeyPoints({ text: privateText });
      await vi.advanceTimersByTimeAsync(30);
      await repairing.promise;
      await vi.advanceTimersByTimeAsync(20);
      safeFailure(await pending, "unavailable");
      expect(calls.map((call) => call.model)).toEqual(["text-primary", "text-primary"]);
      expect(calls[1]!.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await scope.close();
    }
  });

  it("close 等待本实例两个调用取消；另一实例与 caller signal 独立", async () => {
    const twoArrived = deferred();
    let held = 0;
    await withHttp(
      (request, response) => {
        if (JSON.stringify(request.body).includes("独立实例")) json(response, chat(points));
        else {
          held++;
          if (held === 2) twoArrived.resolve();
        }
      },
      async (http) => {
        const first = http.create();
        const other = http.create();
        const caller = new AbortController();
        const a = first.provider.extractKeyPoints({ text: privateText, signal: caller.signal });
        const b = first.provider.tagAsset({ kind: "image", url: privateUrl });
        await twoArrived.promise;
        await first.close();
        safeFailure(await a, "unavailable");
        safeFailure(await b, "unavailable");
        expect(caller.signal.aborted).toBe(false);
        expect(http.sent.slice(0, 2).every((request) => request.init.signal?.aborted)).toBe(true);
        expect(await other.provider.extractKeyPoints({ text: "独立实例" })).toEqual({
          ok: true,
          value: points,
        });
        const count = http.sent.length;
        safeFailure(await first.provider.extractKeyPoints({ text: privateText }), "unavailable");
        await first.close();
        expect(http.sent).toHaveLength(count);
      },
    );
  });

  it("一个 caller 取消不影响同实例另一个并发调用", async () => {
    const arrived = deferred();
    await withHttp(
      (request, response) => {
        if (JSON.stringify(request.body).includes("正常并发")) json(response, chat(points));
        else arrived.resolve();
      },
      async (http) => {
        const scope = http.create();
        const caller = new AbortController();
        const pending = scope.provider.extractKeyPoints({
          text: privateText,
          signal: caller.signal,
        });
        await arrived.promise;
        expect(await scope.provider.extractKeyPoints({ text: "正常并发" })).toEqual({
          ok: true,
          value: points,
        });
        caller.abort();
        safeFailure(await pending, "unavailable");
        expect(http.sent).toHaveLength(2);
        expect(http.sent[1]!.init.signal?.aborted).toBe(false);
      },
    );
  });

  it("成功与 HTTP 拒绝都清除全部期限 timer 和 caller listener", async () => {
    vi.useFakeTimers();
    for (const status of [200, 403]) {
      const caller = new AbortController();
      const add = vi.spyOn(caller.signal, "addEventListener");
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      const transport: typeof fetch = async () =>
        new Response(JSON.stringify(chat(points)), { status });
      const scope = createDomesticLlm(configuration(), { fetch: transport });
      try {
        const result = await scope.provider.extractKeyPoints({
          text: privateText,
          signal: caller.signal,
        });
        if (status === 200) expect(result).toEqual({ ok: true, value: points });
        else safeFailure(result, "rejected");
        expect(vi.getTimerCount()).toBe(0);
        for (const [name, listener] of add.mock.calls) {
          if (name === "abort")
            expect(
              remove.mock.calls.some(([event, removed]) => event === name && removed === listener),
            ).toBe(true);
        }
      } finally {
        await scope.close();
      }
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("close 取消并释放自有 response reader，结束后没有 timer", async () => {
    vi.useFakeTimers();
    const reading = deferred();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const transport: typeof fetch = async () => new Response(stream);
    const scope = createDomesticLlm(configuration(), { fetch: transport });
    try {
      const pending = scope.provider.extractKeyPoints({ text: privateText });
      await reading.promise;
      await scope.close();
      safeFailure(await pending, "unavailable");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(stream.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await scope.close();
    }
  });

  it.each(["caller", "request", "total", "close", "http", "declared", "stream"] as const)(
    "底层 cancel 不 settle 时仍有界结束并释放锁：%s",
    async (mode) => {
      vi.useFakeTimers();
      const cancellation = deferred();
      const cancel = vi.fn(() => cancellation.promise);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === "stream") controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        },
        cancel,
      });
      const caller = new AbortController();
      let calls = 0;
      const transport: typeof fetch = async () => {
        if (++calls > 1) return new Response(JSON.stringify(chat(points)));
        return new Response(stream, {
          status: mode === "http" ? 403 : 200,
          headers: mode === "declared" ? { "content-length": String(1024 * 1024 + 1) } : {},
        });
      };
      const scope = createDomesticLlm(configuration(), {
        fetch: transport,
        timeoutMs: 10,
        totalTimeoutMs: mode === "total" ? 5 : 100,
      });
      let settled = false;
      let result: ProviderResult<unknown> | undefined;
      try {
        const work = scope.provider.extractKeyPoints({ text: privateText, signal: caller.signal });
        void work.then((value) => {
          result = value;
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "caller") caller.abort();
        if (mode === "close") void scope.close();
        await vi.advanceTimersByTimeAsync(30);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(settled).toBe(true);
        expect(stream.locked).toBe(false);
        if (["request", "declared", "stream"].includes(mode)) {
          expect(result).toEqual({ ok: true, value: points });
          expect(calls).toBe(2);
        } else {
          if (!result) throw new Error("调用应在未完成 cancel 时结束");
          safeFailure(result, mode === "http" ? "rejected" : "unavailable");
          expect(calls).toBe(1);
        }
        await scope.close();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        // 整个断言期间 cancel 永不完成；仅失败退出时释放测试 gate，使旧生产 RED 能正常收尾。
        cancellation.resolve();
        await scope.close();
      }
    },
  );

  it("清理的迟到 rejection 被消费，reader 已释放且 close 不等待它", async () => {
    vi.useFakeTimers();
    let rejectCancel!: (reason: Error) => void;
    const cancellation = new Promise<void>((_resolve, reject) => {
      rejectCancel = reject;
    });
    const stream = new ReadableStream<Uint8Array>({ cancel: () => cancellation });
    const caller = new AbortController();
    const scope = createDomesticLlm(configuration(), { fetch: async () => new Response(stream) });
    let settled = false;
    try {
      const work = scope.provider.extractKeyPoints({ text: privateText, signal: caller.signal });
      void work.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(stream.locked).toBe(false);
      await scope.close();
      rejectCancel(new Error("vendor-raw-sensitive"));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rejectCancel(new Error("vendor-raw-sensitive"));
      await scope.close();
    }
  });

  it.each(["body", "reader"] as const)("cancel 同步抛错不改变结果或留下锁：%s", async (mode) => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>();
    const cancel = vi.fn(() => {
      throw new Error("vendor-raw-sensitive");
    });
    if (mode === "body") vi.spyOn(stream, "cancel").mockImplementation(cancel);
    else vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel").mockImplementation(cancel);
    const caller = new AbortController();
    const scope = createDomesticLlm(configuration(), {
      fetch: async () => new Response(stream, { status: mode === "body" ? 403 : 200 }),
    });
    try {
      const observed = scope.provider
        .extractKeyPoints({ text: privateText, signal: caller.signal })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "reader") caller.abort();
      const result = await observed;
      expect(result).not.toHaveProperty("error");
      if (!("value" in result)) throw new Error("清理错误不应成为调用结果");
      safeFailure(result.value, mode === "body" ? "rejected" : "unavailable");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(stream.locked).toBe(false);
      await scope.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await scope.close();
    }
  });
});

describe("国内 LLM：配置拒绝、保旧与外呼守卫", () => {
  it.each([
    { label: "境外或未知 vendor", patch: { vendor: "foreign" } },
    { label: "空 model", patch: { model: "" } },
    { label: "model 含换行", patch: { model: "model\nsecret" } },
    { label: "model 超128", patch: { model: "m".repeat(129) } },
    { label: "model 含URL", patch: { model: "https://foreign.example.invalid" } },
    { label: "空 API key", patch: { apiKey: "" } },
    { label: "key 含换行", patch: { apiKey: "PUBLIC\r\nprivate" } },
    { label: "key 含空格", patch: { apiKey: "PUBLIC KEY" } },
    { label: "key 超512", patch: { apiKey: "K".repeat(513) } },
    { label: "Ark 混入 workspace", patch: { vendor: "ark", workspaceId: "space" } },
    { label: "百炼无 workspace", patch: { vendor: "bailian" } },
    { label: "百炼外部主机", patch: { vendor: "bailian", workspaceId: "space.foreign.invalid" } },
    { label: "百炼注入路径", patch: { vendor: "bailian", workspaceId: "space/path" } },
    { label: "百炼注入端口", patch: { vendor: "bailian", workspaceId: "space:443" } },
    { label: "百炼注入凭据", patch: { vendor: "bailian", workspaceId: "user@space" } },
    { label: "百炼注入查询", patch: { vendor: "bailian", workspaceId: "space?key=x" } },
    { label: "百炼注入 fragment", patch: { vendor: "bailian", workspaceId: "space#private" } },
    { label: "百炼 workspace 前连字符", patch: { vendor: "bailian", workspaceId: "-space" } },
    { label: "百炼 workspace 后连字符", patch: { vendor: "bailian", workspaceId: "space-" } },
    { label: "百炼 workspace 超63", patch: { vendor: "bailian", workspaceId: "s".repeat(64) } },
  ])("$label 构造时拒绝，没有 HTTP", ({ patch }) => {
    const config = configuration();
    config.text.primary = { ...config.text.primary, ...patch } as LlmEndpoint;
    const transport = vi.fn<typeof fetch>();
    expect(() => createDomesticLlm(config, { fetch: transport })).toThrow(TypeError);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { label: "text 主方", role: "text", side: "primary" },
    { label: "text 备方", role: "text", side: "backup" },
    { label: "vision 主方", role: "vision", side: "primary" },
    { label: "vision 备方", role: "vision", side: "backup" },
  ] as const)("$label 必须显式配置，不能借另一角色配置", ({ role, side }) => {
    const config = configuration();
    Reflect.deleteProperty(config[role], side);
    const transport = vi.fn<typeof fetch>();
    expect(() => createDomesticLlm(config, { fetch: transport })).toThrow(TypeError);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 30001 },
    { timeoutMs: 1.5 },
    { timeoutMs: Number.NaN },
    { totalTimeoutMs: 0 },
    { totalTimeoutMs: 60001 },
    { totalTimeoutMs: 1.5 },
    { totalTimeoutMs: Number.POSITIVE_INFINITY },
  ])("非法期限 %j 不扩大硬上限", (options) => {
    expect(() => createDomesticLlm(configuration(), options)).toThrow(TypeError);
  });

  it("构造异常只含固定配置错误，不暴露非法值", () => {
    const config = configuration();
    config.vision.backup.apiKey = "vendor-raw-sensitive\n";
    try {
      createDomesticLlm(config);
      throw new Error("应当拒绝非法配置");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain("vendor-raw-sensitive");
      expect(String(error)).not.toContain(visionBackupUrl);
    }
  });

  it("factory 默认未配置，旧未配文案与接口保持", async () => {
    const logger = createRecordingLogger();
    const llm = createProviders({ appEnv: "prod", logger, beforeCall: () => {} }).llm;
    expect(llm.status).toBe("unconfigured");
    expect(llm.configured).toBe(false);
    expect(await llm.tagAsset({ kind: "image", url: privateUrl })).toMatchObject({
      ok: false,
      reason: "unconfigured",
      message: expect.stringContaining("不打标"),
    });
    expect(await llm.extractKeyPoints({ text: privateText })).toMatchObject({
      ok: false,
      reason: "unconfigured",
      message: expect.stringContaining("不打标"),
    });
  });

  it("fake 默认样例、预置队列、句号拆分保持原事实", async () => {
    const fake = createFakeLlm();
    fake.tagReplies.push({ description: "一碗牛肉面", tags: ["美食", "招牌"] });
    expect(await fake.tagAsset({ kind: "image", url: privateUrl })).toEqual({
      ok: true,
      value: { description: "一碗牛肉面", tags: ["美食", "招牌"] },
    });
    expect(await fake.tagAsset({ kind: "audio", text: privateText })).toEqual({
      ok: true,
      value: { description: "样例素材", tags: ["audio"] },
    });
    fake.keyPointReplies.push(["招牌是牛肉面"]);
    expect(await fake.extractKeyPoints({ text: privateText })).toEqual({
      ok: true,
      value: { points: ["招牌是牛肉面"] },
    });
    expect(await fake.extractKeyPoints({ text: "一。二。三。四。", maxPoints: 2 })).toEqual({
      ok: true,
      value: { points: ["一", "二"] },
    });
    expect(fake.calls.map((call) => call.method)).toEqual([
      "tagAsset",
      "tagAsset",
      "extractKeyPoints",
      "extractKeyPoints",
    ]);
  });

  it.each(["tagAsset", "extractKeyPoints"] as const)(
    "fake %s 遵循 signal，pre-abort 不消费预置",
    async (method) => {
      const fake = createFakeLlm();
      fake.tagReplies.push(tags);
      fake.keyPointReplies.push(points.points);
      const caller = new AbortController();
      caller.abort();
      const result =
        method === "tagAsset"
          ? await fake.tagAsset({ kind: "image", url: privateUrl, signal: caller.signal })
          : await fake.extractKeyPoints({ text: privateText, signal: caller.signal });
      safeFailure(result, "unavailable");
      expect(fake.tagReplies).toHaveLength(1);
      expect(fake.keyPointReplies).toHaveLength(1);
      expect(fake.pendingCalls()).toBe(0);
    },
  );

  it("fake 延迟中 caller abort 释放 pending，不必 tick 或拨钟", async () => {
    const fake = createFakeLlm({ clock: { now: () => new Date("2026-10-10T00:00:00.000Z") } });
    fake.delayNext("extractKeyPoints", 1000);
    const caller = new AbortController();
    const pending = fake.extractKeyPoints({ text: privateText, signal: caller.signal });
    expect(fake.pendingCalls()).toBe(1);
    caller.abort();
    safeFailure(await pending, "unavailable");
    expect(fake.pendingCalls()).toBe(0);
    expect(fake.tick()).toBe(0);
  });

  it.each(["tagAsset", "extractKeyPoints"] as const)(
    "%s 先过 withBeforeCall，抛错原样拒绝且零 HTTP",
    async (method) => {
      await withHttp(
        (_request, response) => json(response, chat(points)),
        async (http) => {
          const guardError = new Error("在事务里调了外部服务");
          const guard = vi.fn(() => {
            throw guardError;
          });
          const provider = withBeforeCall("llm", http.create().provider, guard);
          const pending =
            method === "tagAsset"
              ? provider.tagAsset({ kind: "image", url: privateUrl })
              : provider.extractKeyPoints({ text: privateText });
          await expect(pending).rejects.toBe(guardError);
          expect(guard).toHaveBeenCalledExactlyOnceWith({ provider: "llm", method });
          expect(http.sent).toEqual([]);
        },
      );
    },
  );

  it("一次业务调用的修复和切备不重复触发外呼前守卫", async () => {
    await withHttp(
      (_request, response, index) => json(response, chat(index < 2 ? { points: [] } : points)),
      async (http) => {
        const before = vi.fn();
        const provider = withBeforeCall("llm", http.create().provider, before);
        expect(await provider.extractKeyPoints({ text: privateText })).toEqual({
          ok: true,
          value: points,
        });
        expect(before).toHaveBeenCalledExactlyOnceWith({
          provider: "llm",
          method: "extractKeyPoints",
        });
        expectModels(http.sent, ["text-primary", "text-primary", "text-backup"]);
      },
    );
  });

  it("HTTP 错误、网络错误和模型原文都不输出到 console", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await withHttp(
      (_request, response) =>
        json(response, { error: `vendor-raw-sensitive ${privateText} ${privateUrl}` }, 503),
      async (http) => {
        const first = safeFailure(
          await http.create().provider.extractKeyPoints({ text: privateText }),
          "unavailable",
        );
        const second = safeFailure(
          await http.create().provider.extractKeyPoints({ text: privateText }),
          "unavailable",
        );
        expect(first).toEqual(second);
      },
    );
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
