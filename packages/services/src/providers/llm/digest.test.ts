import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClock, createFakeLlm, createRecordingLogger } from "../../testing/index.js";
import { createProviders } from "../index.js";
import { withBeforeCall } from "../types.js";
import type { LlmDigest, LlmDigestInput, ProviderResult } from "../types.js";
import { createDomesticLlm } from "./driver.js";
import type { DomesticLlmConfig, DomesticLlmOptions } from "./driver.js";
import { LlmDigestSchema, prepareDigest } from "./digest.js";

// 公开虚构凭据与菜单；所有固定官方请求仅转发至本测试真实 loopback HTTP。
const nativeFetch = globalThis.fetch;
const text = "招牌牛肉面32元；汤底每天现熬。仅为协议测试的内部素材。";
const primaryUrl = "https://api.deepseek.com/chat/completions";
const backupUrl = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const minimal: LlmDigest = {
  title: "",
  keypoints: [],
  contentTags: [],
  suggestedUsage: [],
  faceHint: "none",
  qualityNotes: [],
};
function vocabulary() {
  return {
    content: [
      { code: "brand_story", label: "品牌故事" },
      { code: "menu_price", label: "菜单价目" },
    ],
    usage: [{ code: "daily_post", label: "日常发帖" }],
    timeliness: [{ code: "limited_time", label: "限时有效" }],
  };
}
function input(): LlmDigestInput {
  return { text, vocabulary: vocabulary() };
}
function digest(): LlmDigest {
  return {
    title: "每日现熬牛肉面",
    keypoints: ["招牌牛肉面32元", "汤底每天现熬"],
    contentTags: ["brand_story", "menu_price"],
    suggestedUsage: ["daily_post"],
    suggestedTimeliness: { code: "limited_time", from: "2028-02-29", to: "2028-03-01" },
    faceHint: "people_unclear",
    qualityNotes: ["菜单文字清晰"],
    structuredItems: [{ name: "招牌牛肉面", price: "32元" }],
  };
}
function prepared(value: unknown = input()) {
  const result = prepareDigest(value);
  expect(result).toBeDefined();
  if (!result) throw new Error("测试输入应可准备");
  return result;
}
function without(key: string) {
  return Object.fromEntries(Object.entries(digest()).filter(([name]) => name !== key));
}
function configuration(): DomesticLlmConfig {
  return {
    text: {
      primary: { vendor: "deepseek", model: "digest-primary", apiKey: "PUBLIC_DIGEST_PRIMARY" },
      backup: { vendor: "ark", model: "digest-backup", apiKey: "PUBLIC_DIGEST_BACKUP" },
    },
    vision: {
      primary: { vendor: "ark", model: "unused-vision", apiKey: "PUBLIC_UNUSED_VISION" },
      backup: { vendor: "deepseek", model: "unused-vision-backup", apiKey: "PUBLIC_UNUSED_BACKUP" },
    },
  };
}
type Wire = {
  model: string;
  stream: boolean;
  response_format: unknown;
  messages: Array<{ role: string; content: string }>;
};
type Sent = { url: string; init: RequestInit; body: Wire };
type Owned = ReturnType<typeof createDomesticLlm>;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function envelope(value: unknown, extra: Record<string, unknown> = {}, finish = "stop") {
  return {
    choices: [
      {
        finish_reason: finish,
        message: { role: "assistant", content: JSON.stringify(value), ...extra },
      },
    ],
  };
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
function safeFailure(result: ProviderResult<unknown>, reason: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("不应成功");
  expect(Object.keys(result).sort()).toEqual(["message", "ok", "reason"]);
  expect(result.reason).toBe(reason);
  expect(result.message).not.toBe("");
  for (const secret of [
    text,
    "vendor-sensitive",
    "PUBLIC_DIGEST_PRIMARY",
    "PUBLIC_DIGEST_BACKUP",
    primaryUrl,
    backupUrl,
  ])
    expect(JSON.stringify(result)).not.toContain(secret);
}
async function withHttp(
  reply: (response: ServerResponse, index: number, body: Wire) => unknown,
  run: (http: {
    sent: Sent[];
    bodies: Array<ReadableStream<Uint8Array>>;
    create(options?: DomesticLlmOptions): Owned;
  }) => Promise<void>,
) {
  const sent: Sent[] = [],
    bodies: Array<ReadableStream<Uint8Array>> = [],
    owned: Owned[] = [],
    errors: unknown[] = [];
  let received = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: Wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await reply(response, received++, body);
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback 未就绪");
  const forwarding: typeof fetch = async (target, init) => {
    const url = String(target);
    if (![primaryUrl, backupUrl].includes(url) || !init || typeof init.body !== "string")
      throw new Error("仅允许固定 text 官方目的地与 JSON body");
    sent.push({ url, init, body: JSON.parse(init.body) });
    const response = await nativeFetch(`http://127.0.0.1:${address.port}/digest`, init);
    if (response.body) bodies.push(response.body);
    return response;
  };
  try {
    await run({
      sent,
      bodies,
      create(options = {}) {
        const scope = createDomesticLlm(configuration(), { ...options, fetch: forwarding });
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
function models(sent: Sent[], expected: string[]) {
  expect(sent.map((request) => request.body.model)).toEqual(expected);
  expect(sent.length).toBeLessThanOrEqual(3);
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("digest DTO：D5 必填、可选与码点边界", () => {
  it("完整模型 DTO 原样返回，最小空字符串/空数组合法且不填可选字段", () => {
    expect(LlmDigestSchema.parse(digest())).toEqual(digest());
    expect(prepared().parse(digest())).toEqual(digest());
    expect(LlmDigestSchema.parse(minimal)).toEqual(minimal);
    expect(prepared().parse(minimal)).toEqual(minimal);
    expect(prepared().parse(minimal)).not.toHaveProperty("structuredItems");
    expect(prepared().parse(minimal)).not.toHaveProperty("suggestedTimeliness");
  });
  it.each(["title", "keypoints", "contentTags", "suggestedUsage", "faceHint", "qualityNotes"])(
    "缺必填 %s 不能补默认",
    (key) => {
      expect(LlmDigestSchema.safeParse(without(key)).success).toBe(false);
      expect(prepared().parse(without(key))).toBeUndefined();
    },
  );
  it.each(["none", "people_unclear", "identifiable_customer"] as const)(
    "faceHint %s 如实保留",
    (faceHint) => {
      expect(prepared().parse({ ...minimal, faceHint })).toEqual({ ...minimal, faceHint });
    },
  );
  const strings = [
    { label: "title", max: 20, patch: (value: string) => ({ title: value }) },
    { label: "keypoints", max: 60, patch: (value: string) => ({ keypoints: [value] }) },
    { label: "qualityNotes", max: 40, patch: (value: string) => ({ qualityNotes: [value] }) },
    { label: "name", max: 30, patch: (value: string) => ({ structuredItems: [{ name: value }] }) },
    {
      label: "price",
      max: 20,
      patch: (value: string) => ({ structuredItems: [{ name: "", price: value }] }),
    },
  ];
  it.each(strings)("$label 空值、上界和 astral 码点上界合法，超一个拒绝", ({ max, patch }) => {
    for (const unit of ["面", "🍜"]) {
      for (const count of [0, max]) {
        const value = { ...minimal, ...patch(unit.repeat(count)) };
        expect(LlmDigestSchema.safeParse(value).success).toBe(true);
        expect(prepared().parse(value)).toEqual(value);
      }
      const value = { ...minimal, ...patch(unit.repeat(max + 1)) };
      expect(LlmDigestSchema.safeParse(value).success).toBe(false);
      expect(prepared().parse(value)).toBeUndefined();
    }
  });
  it.each([
    { key: "keypoints", max: 6, item: "" },
    { key: "qualityNotes", max: 3, item: "" },
    { key: "structuredItems", max: 50, item: { name: "", price: "" } },
  ])("$key 数组0/$max合法、再多一个拒绝", ({ key, max, item }) => {
    for (const size of [0, max, max + 1]) {
      const value = { ...minimal, [key]: Array.from({ length: size }, () => item) };
      expect(LlmDigestSchema.safeParse(value).success).toBe(size <= max);
      expect(prepared().parse(value)).toEqual(size <= max ? value : undefined);
    }
  });
  it.each([
    { title: null },
    { title: 1 },
    { keypoints: "面" },
    { keypoints: [1] },
    { contentTags: "brand_story" },
    { contentTags: [null] },
    { suggestedUsage: 1 },
    { suggestedUsage: [false] },
    { faceHint: "recognized_person" },
    { faceHint: null },
    { qualityNotes: null },
    { qualityNotes: [{}] },
    { structuredItems: null },
    { structuredItems: [null] },
    { structuredItems: [{}] },
    { structuredItems: [{ name: 1 }] },
    { structuredItems: [{ name: "面", price: 32 }] },
    { structuredItems: [{ name: "面", extra: "vendor-sensitive" }] },
    { suggestedTimeliness: null },
    { suggestedTimeliness: {} },
    { suggestedTimeliness: { code: "limited_time", from: null } },
    { suggestedTimeliness: { code: "limited_time", to: 1 } },
    { suggestedTimeliness: { code: "limited_time", extra: true } },
    { extra: "vendor-sensitive" },
  ])("严格拒绝错误类型或额外键 %j", (patch) => {
    const value = { ...digest(), ...patch };
    expect(LlmDigestSchema.safeParse(value).success).toBe(false);
    expect(prepared().parse(value)).toBeUndefined();
  });
  it.each([null, false, 1, "{}", [], [minimal]])("非对象业务JSON %j 不成功", (value) => {
    expect(LlmDigestSchema.safeParse(value).success).toBe(false);
    expect(prepared().parse(value)).toBeUndefined();
  });
  it.each([
    { code: "limited_time" },
    { code: "limited_time", from: "2028-02-29" },
    { code: "limited_time", to: "2028-02-29" },
    { code: "limited_time", from: "2028-02-29", to: "2028-02-29" },
  ])("可选日期不补值 %j", (suggestedTimeliness) => {
    const value = { ...minimal, suggestedTimeliness };
    expect(prepared().parse(value)).toEqual(value);
  });
  it.each([
    "2027-02-29",
    "2028-02-30",
    "2028-04-31",
    "2028-00-01",
    "2028-13-01",
    "2028-01-00",
    "28-01-01",
    "2028-1-01",
    "2028-01-01T00:00:00Z",
  ])("非真实ISO日期 %s 拒绝", (from) => {
    expect(
      prepared().parse({ ...minimal, suggestedTimeliness: { code: "limited_time", from } }),
    ).toBeUndefined();
  });
  it("倒置日期拒绝；合法年月日不被时区改写", () => {
    expect(
      prepared().parse({
        ...digest(),
        suggestedTimeliness: { code: "limited_time", from: "2028-03-01", to: "2028-02-29" },
      }),
    ).toBeUndefined();
    expect(prepared().parse(digest())).toEqual(digest());
  });
});

describe("digest 词表快照、未知过滤与 prompt 输入", () => {
  it("未知标签仅过滤，顺序/重复保留；未知时效整项省略", () => {
    const value = {
      ...digest(),
      contentTags: ["未知标签", "brand_story", "", "brand_story", "menu_price"],
      suggestedUsage: ["unknown", "daily_post", " "],
      suggestedTimeliness: { code: "unknown", from: "2028-02-29" },
    };
    const expected = digest();
    expected.contentTags = ["brand_story", "brand_story", "menu_price"];
    Reflect.deleteProperty(expected, "suggestedTimeliness");
    expect(prepared().parse(value)).toEqual(expected);
  });
  it("标签维度严格隔离，空词表仍可成功而不造code或时效", () => {
    const value = { ...digest(), contentTags: ["daily_post"], suggestedUsage: ["brand_story"] };
    const expected = { ...digest(), contentTags: [], suggestedUsage: [] };
    expect(prepared().parse(value)).toEqual(expected);
    Reflect.deleteProperty(expected, "suggestedTimeliness");
    expect(
      prepared({ text, vocabulary: { content: [], usage: [], timeliness: [] } }).parse(digest()),
    ).toEqual(expected);
  });
  it.each(["contentTags", "suggestedUsage"] as const)("%s raw有界过滤后再核final上限", (key) => {
    const code = key === "contentTags" ? "brand_story" : "daily_post";
    const max = key === "contentTags" ? 4 : 3;
    const parse = prepared().parse;
    const known = Array.from({ length: max }, () => code);
    expect(
      parse({
        ...minimal,
        [key]: [...Array.from({ length: 256 - max }, () => "unknown"), ...known],
      }),
    ).toEqual({ ...minimal, [key]: known });
    expect(
      parse({ ...minimal, [key]: Array.from({ length: 257 }, () => "unknown") }),
    ).toBeUndefined();
    expect(parse({ ...minimal, [key]: [...known, code, "unknown"] })).toBeUndefined();
    expect(parse({ ...minimal, [key]: ["🍜".repeat(100)] })).toEqual(minimal);
    expect(parse({ ...minimal, [key]: ["🍜".repeat(101)] })).toBeUndefined();
  });
  it("unknown 时效不能掩盖坏日期或额外字段", () => {
    expect(
      prepared().parse({ ...minimal, suggestedTimeliness: { code: "🍜".repeat(100) } }),
    ).toEqual(minimal);
    for (const suggestedTimeliness of [
      { code: "unknown", from: "2027-02-29" },
      { code: "unknown", extra: true },
      { code: "x".repeat(101) },
      { code: 1 },
    ])
      expect(prepared().parse({ ...minimal, suggestedTimeliness })).toBeUndefined();
  });
  it("词表调用前深拷贝；调用者改code/label/数组不改变prompt或解析", () => {
    const words = vocabulary();
    const plan = prepared({ text, vocabulary: words });
    const before = plan.content;
    words.content[0]!.code = "new_code";
    words.content[1]!.label = "修改后的名称";
    words.usage.splice(0);
    words.timeliness[0]!.code = "new_time";
    expect(plan.content).toBe(before);
    expect(plan.content).toContain("品牌故事");
    expect(plan.content).not.toContain("修改后的名称");
    expect(plan.parse(digest())).toEqual(digest());
    expect(plan.parse({ ...minimal, contentTags: ["new_code"] })).toEqual(minimal);
  });
  it("返回 DTO 不与 raw 嵌套对象共享引用", () => {
    const raw = digest();
    const result = prepared().parse(raw);
    expect(result).toBeDefined();
    if (!result) throw new Error("应成功");
    result.keypoints.push("后来修改");
    result.structuredItems![0]!.name = "后来修改";
    result.suggestedTimeliness!.from = "2028-01-01";
    expect(raw).toEqual(digest());
  });
  const invalidInputs: Array<{ label: string; value: unknown }> = [
    { label: "null", value: null },
    { label: "空object", value: {} },
    { label: "空text", value: { ...input(), text: "" } },
    { label: "空白text", value: { ...input(), text: " \n\t" } },
    { label: "非string text", value: { ...input(), text: 1 } },
    { label: "text单独超64KiB", value: { ...input(), text: "中".repeat(21846) } },
    { label: "缺vocabulary", value: { text } },
    { label: "null词表", value: { text, vocabulary: null } },
    { label: "缺dimension", value: { text, vocabulary: { content: [], usage: [] } } },
    {
      label: "dimension非array",
      value: { text, vocabulary: { ...vocabulary(), content: "brand_story" } },
    },
    { label: "null成员", value: { text, vocabulary: { ...vocabulary(), content: [null] } } },
    {
      label: "缺label",
      value: { text, vocabulary: { ...vocabulary(), content: [{ code: "menu" }] } },
    },
    {
      label: "空code",
      value: { text, vocabulary: { ...vocabulary(), content: [{ code: "", label: "菜单" }] } },
    },
    {
      label: "中文code",
      value: { text, vocabulary: { ...vocabulary(), content: [{ code: "菜单", label: "菜单" }] } },
    },
    {
      label: "code超16",
      value: {
        text,
        vocabulary: { ...vocabulary(), content: [{ code: "a".repeat(17), label: "菜单" }] },
      },
    },
    {
      label: "code含点",
      value: {
        text,
        vocabulary: { ...vocabulary(), content: [{ code: "menu.v1", label: "菜单" }] },
      },
    },
    {
      label: "code含空白",
      value: { text, vocabulary: { ...vocabulary(), content: [{ code: " menu", label: "菜单" }] } },
    },
    {
      label: "空label",
      value: { text, vocabulary: { ...vocabulary(), content: [{ code: "menu", label: "" }] } },
    },
    {
      label: "label超20",
      value: {
        text,
        vocabulary: { ...vocabulary(), content: [{ code: "menu", label: "面".repeat(21) }] },
      },
    },
    {
      label: "label错误类型",
      value: { text, vocabulary: { ...vocabulary(), content: [{ code: "menu", label: 1 }] } },
    },
    { label: "额外词表字段", value: { text, vocabulary: { ...vocabulary(), other: [] } } },
    {
      label: "额外成员字段",
      value: {
        text,
        vocabulary: { ...vocabulary(), content: [{ code: "menu", label: "菜单", extra: true }] },
      },
    },
    { label: "额外输入字段", value: { ...input(), model: "unsafe" } },
    { label: "伪signal", value: { ...input(), signal: { aborted: false } } },
  ];
  it.each(invalidInputs)("$label 在准备时拒绝", ({ value }) => {
    expect(prepareDigest(value)).toBeUndefined();
  });
  it.each(["content", "usage", "timeliness"] as const)(
    "%s 256项合法、257拒绝，code/name实际上下界",
    (dimension) => {
      const entries = Array.from({ length: 256 }, (_, index) => ({
        code: `A_${index}-z`,
        label: "面".repeat(20),
      }));
      expect(
        prepareDigest({
          text,
          vocabulary: { content: [], usage: [], timeliness: [], [dimension]: entries },
        }),
      ).toBeDefined();
      expect(
        prepareDigest({
          text,
          vocabulary: {
            content: [],
            usage: [],
            timeliness: [],
            [dimension]: [{ code: "a".repeat(16), label: " " }],
          },
        }),
      ).toBeDefined();
      entries.push({ code: "a".repeat(16), label: " " });
      expect(
        prepareDigest({
          text,
          vocabulary: { content: [], usage: [], timeliness: [], [dimension]: entries },
        }),
      ).toBeUndefined();
      expect(
        prepareDigest({
          text,
          vocabulary: {
            content: [],
            usage: [],
            timeliness: [],
            [dimension]: [{ code: "_", label: "🍜".repeat(20) }],
          },
        }),
      ).toBeDefined();
      expect(
        prepareDigest({
          text,
          vocabulary: {
            content: [],
            usage: [],
            timeliness: [],
            [dimension]: [{ code: "a".repeat(16), label: "🍜".repeat(21) }],
          },
        }),
      ).toBeUndefined();
    },
  );
  it.each([
    ["content", "content"],
    ["content", "usage"],
    ["content", "timeliness"],
    ["usage", "timeliness"],
  ] as const)("%s 与%s重复code不允许", (source, dimension) => {
    const words = vocabulary();
    words[dimension].push({ ...words[source][0]! });
    expect(prepareDigest({ text, vocabulary: words })).toBeUndefined();
  });
  it.each(["a", "中"])("最终JSON恰64KiB合法、超1字节拒绝：%s", (unit) => {
    const words = { content: [], usage: [], timeliness: [] };
    const overhead = Buffer.byteLength(prepared({ text: "a", vocabulary: words }).content) - 1;
    const count = Math.floor((65536 - overhead) / Buffer.byteLength(unit));
    const body =
      unit.repeat(count) + "a".repeat(65536 - overhead - count * Buffer.byteLength(unit));
    const plan = prepared({ text: body, vocabulary: words });
    expect(Buffer.byteLength(plan.content)).toBe(65536);
    expect(prepareDigest({ text: body + "a", vocabulary: words })).toBeUndefined();
  });
  it("JSON转义也计入总prompt预算；signal不序列化", () => {
    const caller = new AbortController();
    const plan = prepared({ ...input(), signal: caller.signal });
    expect(plan.content).not.toContain("signal");
    expect(prepareDigest({ ...input(), text: "a" + "\n".repeat(32768) })).toBeUndefined();
  });
});

describe("summarizeAsset：纯流与fake timer清理（先于所有native HTTP）", () => {
  it.each(["caller", "request", "total", "close", "http", "declared", "stream"] as const)(
    "不完成的stream.cancel不延长本地等待：%s",
    async (mode) => {
      vi.useFakeTimers();
      const canceled = gate();
      const cancel = vi.fn(() => canceled.promise);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === "stream") controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        },
        cancel,
      });
      let calls = 0;
      const transport: typeof fetch = async () =>
        ++calls > 1
          ? new Response(JSON.stringify(envelope(minimal)))
          : new Response(stream, {
              status: mode === "http" ? 403 : 200,
              headers: mode === "declared" ? { "content-length": String(1024 * 1024 + 1) } : {},
            });
      const scope = createDomesticLlm(configuration(), {
        fetch: transport,
        timeoutMs: 10,
        totalTimeoutMs: mode === "total" ? 5 : 100,
      });
      const caller = new AbortController();
      let result: ProviderResult<LlmDigest> | undefined;
      try {
        void scope.provider.summarizeAsset({ ...input(), signal: caller.signal }).then((value) => {
          result = value;
        });
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "caller") caller.abort();
        if (mode === "close") void scope.close();
        await vi.advanceTimersByTimeAsync(30);
        expect(cancel).toHaveBeenCalledOnce();
        expect(stream.locked).toBe(false);
        if (!result) throw new Error("cancel未settle时调用仍应已结束");
        if (["request", "declared", "stream"].includes(mode))
          expect(result).toEqual({ ok: true, value: minimal });
        else safeFailure(result, mode === "http" ? "rejected" : "unavailable");
        expect(calls).toBe(["request", "declared", "stream"].includes(mode) ? 2 : 1);
        await scope.close();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        canceled.release();
        await scope.close();
      }
    },
  );
  it.each([200, 403])("HTTP %i 删除 caller listener，不留下请求/总期限timer", async (status) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, "addEventListener"),
      remove = vi.spyOn(caller.signal, "removeEventListener");
    const scope = createDomesticLlm(configuration(), {
      fetch: async () => new Response(JSON.stringify(envelope(minimal)), { status }),
    });
    try {
      const result = await scope.provider.summarizeAsset({ ...input(), signal: caller.signal });
      if (status === 200) expect(result).toEqual({ ok: true, value: minimal });
      else safeFailure(result, "rejected");
      expect(add).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await scope.close();
    }
  });
});

describe("summarizeAsset：真实 loopback JSON 协议与有界主备", () => {
  it("使用 text 官方URL/模型/JSON模式，发送同一词表快照与完整schema", async () => {
    await withHttp(
      (response) => json(response, envelope(digest())),
      async (http) => {
        const scope = http.create();
        expect(scope.provider.status).toBe("domestic-llm");
        expect(scope.provider.configured).toBe(true);
        expect(await scope.provider.summarizeAsset(input())).toEqual({ ok: true, value: digest() });
        models(http.sent, ["digest-primary"]);
        const sent = http.sent[0]!;
        expect(sent.url).toBe(primaryUrl);
        expect(sent.init).toMatchObject({ method: "POST", redirect: "error" });
        const headers = new Headers(sent.init.headers);
        expect(headers.get("authorization")).toBe("Bearer PUBLIC_DIGEST_PRIMARY");
        expect(headers.get("content-type")).toContain("application/json");
        expect(sent.body).toMatchObject({
          stream: false,
          response_format: { type: "json_object" },
        });
        expect(Object.keys(sent.body).sort()).toEqual([
          "messages",
          "model",
          "response_format",
          "stream",
        ]);
        expect(sent.body.messages.map((message) => message.role)).toEqual(["system", "user"]);
        expect(JSON.parse(sent.body.messages[1]!.content)).toEqual({
          evidence: text,
          vocabulary: vocabulary(),
        });
        for (const key of Object.keys(digest()))
          expect(sent.body.messages[0]!.content).toContain(key);
        expect(JSON.stringify(sent.body)).not.toContain("image_url");
        expect(http.bodies.every((body) => !body.locked)).toBe(true);
      },
    );
  });
  it("未知标签过滤后一次成功，不触发repair；发送后修改词表不改变回包过滤", async () => {
    const raw = {
      ...minimal,
      contentTags: ["unknown", "brand_story"],
      suggestedUsage: ["unknown"],
      suggestedTimeliness: { code: "unknown" },
    };
    await withHttp(
      (response) => json(response, envelope(raw)),
      async (http) => {
        const words = vocabulary();
        const pending = http.create().provider.summarizeAsset({ text, vocabulary: words });
        words.content[0]!.code = "changed_code";
        words.content[0]!.label = "调用后修改";
        expect(await pending).toEqual({
          ok: true,
          value: { ...minimal, contentTags: ["brand_story"] },
        });
        models(http.sent, ["digest-primary"]);
        expect(http.sent[0]!.body.messages[1]!.content).not.toContain("调用后修改");
      },
    );
  });
  it.each(["primary-repair-backup", "backup-repair"] as const)(
    "全局一次repair、至多3请求：%s",
    async (mode) => {
      await withHttp(
        (response, index) => {
          if (mode === "backup-repair" && index === 0)
            json(response, { error: "vendor-sensitive" }, 503);
          else json(response, envelope(index === 2 ? digest() : { title: "vendor-sensitive" }));
        },
        async (http) => {
          expect(await http.create().provider.summarizeAsset(input())).toEqual({
            ok: true,
            value: digest(),
          });
          models(
            http.sent,
            mode === "backup-repair"
              ? ["digest-primary", "digest-backup", "digest-backup"]
              : ["digest-primary", "digest-primary", "digest-backup"],
          );
          const repair = http.sent[mode === "backup-repair" ? 2 : 1]!;
          expect(repair.body.messages[0]!.content).toContain("previous output");
          for (const request of http.sent) {
            expect(JSON.stringify(request.body)).not.toContain("vendor-sensitive");
            expect(request.body.messages[1]!.content).toBe(http.sent[0]!.body.messages[1]!.content);
          }
          expect(http.sent.at(-1)!.url).toBe(backupUrl);
          expect(new Headers(http.sent.at(-1)!.init.headers).get("authorization")).toBe(
            "Bearer PUBLIC_DIGEST_BACKUP",
          );
        },
      );
    },
  );
  it("持续缺字段三次后安全失败，不用fake样例或默认数组补成功", async () => {
    await withHttp(
      (response) => json(response, envelope({ title: "vendor-sensitive" })),
      async (http) => {
        safeFailure(await http.create().provider.summarizeAsset(input()), "unavailable");
        models(http.sent, ["digest-primary", "digest-primary", "digest-backup"]);
      },
    );
  });
  it.each([408, 429, 500, 503])("HTTP %i 只切一次 text备方", async (status) => {
    await withHttp(
      (response, index) =>
        index === 0
          ? json(response, { error: "vendor-sensitive" }, status)
          : json(response, envelope(minimal)),
      async (http) => {
        expect(await http.create().provider.summarizeAsset(input())).toEqual({
          ok: true,
          value: minimal,
        });
        models(http.sent, ["digest-primary", "digest-backup"]);
      },
    );
  });
  it.each([400, 401, 403, 422])("HTTP %i 不repair不切备", async (status) => {
    await withHttp(
      (response) => json(response, { error: `vendor-sensitive ${text}` }, status),
      async (http) => {
        safeFailure(await http.create().provider.summarizeAsset(input()), "rejected");
        models(http.sent, ["digest-primary"]);
      },
    );
  });
  it.each([
    { label: "refusal", extra: { refusal: "vendor-sensitive" } },
    { label: "tool", extra: { tool_calls: [{ name: "vendor-sensitive" }] } },
    { label: "function", extra: { function_call: { name: "vendor-sensitive" } } },
  ])("明确$label立即拒绝，无schema修复/切备", async ({ extra }) => {
    await withHttp(
      (response) => json(response, envelope(digest(), extra)),
      async (http) => {
        safeFailure(await http.create().provider.summarizeAsset(input()), "rejected");
        models(http.sent, ["digest-primary"]);
      },
    );
  });
  it.each(["network", "utf8", "declared", "chunked", "choice", "length"] as const)(
    "坏传输/协议 %s 只切一次备方",
    async (mode) => {
      await withHttp(
        (response, index) => {
          if (index > 0) return json(response, envelope(digest()));
          if (mode === "network") return response.destroy();
          if (mode === "utf8") return response.end(Buffer.from([0xff, 0xfe]));
          if (mode === "declared") {
            response.writeHead(200, { "content-length": String(1024 * 1024 + 1) });
            return response.end("vendor-sensitive");
          }
          if (mode === "chunked") {
            response.writeHead(200);
            response.write(Buffer.alloc(600_000, 32));
            return response.end(Buffer.alloc(600_000, 32));
          }
          return json(
            response,
            mode === "choice" ? { choices: [] } : envelope(digest(), {}, "length"),
          );
        },
        async (http) => {
          expect(await http.create().provider.summarizeAsset(input())).toEqual({
            ok: true,
            value: digest(),
          });
          models(http.sent, ["digest-primary", "digest-backup"]);
          expect(http.bodies.every((body) => !body.locked)).toBe(true);
        },
      );
    },
  );
  it.each([
    { text: "" },
    { text: " \n" },
    { text: "a".repeat(65536) },
    { vocabulary: { ...vocabulary(), content: [{ code: "not.valid", label: "菜单" }] } },
    { vocabulary: { ...vocabulary(), usage: [{ code: "brand_story", label: "重复编码" }] } },
  ])("类型正确但不合输入契约 %j 零HTTP", async (patch) => {
    await withHttp(
      (response) => json(response, envelope(digest())),
      async (http) => {
        safeFailure(
          await http.create().provider.summarizeAsset({ ...input(), ...patch }),
          "rejected",
        );
        expect(http.sent).toEqual([]);
      },
    );
  });
});

describe("summarizeAsset：abort、期限、close与reader清理", () => {
  it("pre-abort零HTTP且不改 caller 状态", async () => {
    const caller = new AbortController();
    caller.abort();
    await withHttp(
      (response) => json(response, envelope(minimal)),
      async (http) => {
        safeFailure(
          await http.create().provider.summarizeAsset({ ...input(), signal: caller.signal }),
          "unavailable",
        );
        expect(http.sent).toEqual([]);
        expect(caller.signal.aborted).toBe(true);
      },
    );
  });
  it.each(["caller", "request", "total", "close"] as const)(
    "真实HTTP读流中 %s 有界结束且释放reader",
    async (mode) => {
      const arrived = gate();
      await withHttp(
        (response, index) => {
          if (index > 0) return json(response, envelope(minimal));
          response.writeHead(200);
          response.write('{"choices":[');
          arrived.release();
        },
        async (http) => {
          const caller = new AbortController();
          const scope = http.create({
            timeoutMs: mode === "request" ? 150 : 2000,
            totalTimeoutMs: mode === "total" ? 150 : 5000,
          });
          const pending = scope.provider.summarizeAsset({ ...input(), signal: caller.signal });
          await Promise.race([
            arrived.promise,
            pending.then(() => {
              throw new Error("调用在到达HTTP前结束");
            }),
          ]);
          if (mode === "caller" || mode === "close") {
            await vi.waitFor(() => expect(http.bodies.some((body) => body.locked)).toBe(true), {
              timeout: 1000,
            });
            if (mode === "caller") caller.abort();
            else await scope.close();
          }
          const result = await pending;
          if (mode === "request") expect(result).toEqual({ ok: true, value: minimal });
          else safeFailure(result, "unavailable");
          models(
            http.sent,
            mode === "request" ? ["digest-primary", "digest-backup"] : ["digest-primary"],
          );
          expect(http.sent[0]!.init.signal?.aborted).toBe(true);
          expect(http.bodies.every((body) => !body.locked)).toBe(true);
          expect(caller.signal.aborted).toBe(mode === "caller");
        },
      );
    },
  );
  it("close取消本实例两个调用，另一实例正常；关闭后零外呼", async () => {
    const arrived = gate();
    let count = 0;
    await withHttp(
      (response, index) => {
        if (index >= 2) return json(response, envelope(minimal));
        if (++count === 2) arrived.release();
      },
      async (http) => {
        const first = http.create(),
          other = http.create();
        const a = first.provider.summarizeAsset(input()),
          b = first.provider.summarizeAsset(input());
        await Promise.race([
          arrived.promise,
          Promise.all([a, b]).then(() => {
            throw new Error("两个调用在到达HTTP前结束");
          }),
        ]);
        await first.close();
        safeFailure(await a, "unavailable");
        safeFailure(await b, "unavailable");
        expect(await other.provider.summarizeAsset(input())).toEqual({ ok: true, value: minimal });
        safeFailure(await first.provider.summarizeAsset(input()), "unavailable");
        expect(http.sent).toHaveLength(3);
        await first.close();
      },
    );
  });
});

describe("summarizeAsset：注册、未配置与独立fake队列", () => {
  it("factory默认仍未配置，新方法存在且返回受控未配置", async () => {
    const logger = createRecordingLogger();
    const provider = createProviders({ appEnv: "prod", logger, beforeCall: () => {} }).llm;
    expect(provider.status).toBe("unconfigured");
    expect(provider.configured).toBe(false);
    safeFailure(await provider.summarizeAsset(input()), "unconfigured");
  });
  it("fake digestReplies独立消费，嵌套深拷贝且旧两方法不变", async () => {
    const fake = createFakeLlm();
    const original = digest();
    fake.digestReplies.push(original, minimal);
    fake.tagReplies.push({ description: "旧打标", tags: ["旧标签"] });
    fake.keyPointReplies.push(["旧要点"]);
    const result = await fake.summarizeAsset(input());
    expect(result).toEqual({ ok: true, value: original });
    if (!result.ok) throw new Error("fake应成功");
    result.value.structuredItems![0]!.name = "已修改";
    result.value.suggestedTimeliness!.from = "2028-01-01";
    result.value.keypoints.push("已修改");
    expect(original).toEqual(digest());
    expect(fake.tagReplies).toHaveLength(1);
    expect(fake.keyPointReplies).toHaveLength(1);
    expect(await fake.tagAsset({ kind: "audio", text })).toEqual({
      ok: true,
      value: { description: "旧打标", tags: ["旧标签"] },
    });
    expect(await fake.extractKeyPoints({ text })).toEqual({
      ok: true,
      value: { points: ["旧要点"] },
    });
    expect(await fake.summarizeAsset(input())).toEqual({ ok: true, value: minimal });
    expect(fake.digestReplies).toEqual([]);
    expect(await fake.tagAsset({ kind: "audio", text })).toEqual({
      ok: true,
      value: { description: "样例素材", tags: ["audio"] },
    });
    expect(await fake.extractKeyPoints({ text: "一。二。三。四。", maxPoints: 2 })).toEqual({
      ok: true,
      value: { points: ["一", "二"] },
    });
  });
  it("fake缺省完整typed样例，不挪用旧队列；每次返回独立对象", async () => {
    const fake = createFakeLlm();
    const a = await fake.summarizeAsset(input()),
      b = await fake.summarizeAsset(input());
    expect(a).toEqual({ ok: true, value: { ...minimal, title: "公开虚构摘要样例" } });
    expect(b).toEqual(a);
    if (!a.ok || !b.ok) throw new Error("样例应成功");
    expect(LlmDigestSchema.safeParse(a.value).success).toBe(true);
    a.value.keypoints.push("已修改");
    expect(b.value.keypoints).toEqual([]);
  });
  it("fake pre-abort不消费digest预置；失败注入也不挪用队列", async () => {
    const fake = createFakeLlm();
    fake.digestReplies.push(digest());
    const caller = new AbortController();
    caller.abort();
    safeFailure(await fake.summarizeAsset({ ...input(), signal: caller.signal }), "unavailable");
    fake.failNext("summarizeAsset");
    safeFailure(await fake.summarizeAsset(input()), "unavailable");
    expect(fake.digestReplies).toEqual([digest()]);
    expect(await fake.summarizeAsset(input())).toEqual({ ok: true, value: digest() });
    expect(fake.pendingCalls()).toBe(0);
  });
  it("fake延迟中的signal abort移除pending与listener，不必tick", async () => {
    const clock = createClock(),
      fake = createFakeLlm({ clock });
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    fake.delayNext("summarizeAsset", 1000);
    const pending = fake.summarizeAsset({ ...input(), signal: caller.signal });
    expect(fake.pendingCalls()).toBe(1);
    caller.abort();
    safeFailure(await pending, "unavailable");
    expect(fake.pendingCalls()).toBe(0);
    expect(remove).toHaveBeenCalled();
    clock.advance(1000);
    expect(fake.tick()).toBe(0);
  });
  it.each(["fake", "domestic"] as const)(
    "%s 的summarizeAsset先经withBeforeCall，拒绝后零底层调用",
    async (mode) => {
      await withHttp(
        (response) => json(response, envelope(minimal)),
        async (http) => {
          const fake = createFakeLlm();
          fake.digestReplies.push(digest());
          const failure = new Error("外呼守卫拒绝");
          const before = vi.fn(() => {
            throw failure;
          });
          const provider = withBeforeCall(
            "llm",
            mode === "fake" ? fake : http.create().provider,
            before,
          );
          await expect(provider.summarizeAsset(input())).rejects.toBe(failure);
          expect(before).toHaveBeenCalledExactlyOnceWith({
            provider: "llm",
            method: "summarizeAsset",
          });
          expect(http.sent).toEqual([]);
          expect(fake.calls).toEqual([]);
          expect(fake.digestReplies).toEqual([digest()]);
        },
      );
    },
  );
});
