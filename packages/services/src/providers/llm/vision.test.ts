import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClock, createFakeLlm, createRecordingLogger } from "../../testing/index.js";
import { createProviders } from "../index.js";
import { LlmVisionSchema, withBeforeCall } from "../types.js";
import type { LlmVision, LlmVisionInput, ProviderResult } from "../types.js";
import { createDomesticLlm } from "./driver.js";
import type { DomesticLlmConfig, DomesticLlmOptions } from "./driver.js";
import { prepareVision } from "./vision.js";

// All credentials/images are public synthetic fixtures. Official URLs only reach owned loopback.
const nativeFetch = globalThis.fetch;
const primaryUrl = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const backupUrl =
  "https://vision-space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions";
const image = "https://assets.example.invalid/menu.jpg?signature=PUBLIC_IMAGE_SIGNATURE";
const minimum: LlmVision = {
  description: "",
  quality: "",
  hasPeople: false,
  identifiableCustomerFace: false,
  textInImage: "",
};
const vision = (): LlmVision => ({
  description: "公开虚构菜单与制作区",
  quality: "文字清晰，室内光线均匀",
  hasPeople: true,
  identifiableCustomerFace: false,
  textInImage: "公开虚构牛肉面32元",
});
const input = (): LlmVisionInput => ({ imageUrls: [image] });
function configuration(): DomesticLlmConfig {
  return {
    text: {
      primary: { vendor: "deepseek", model: "unused-text", apiKey: "PUBLIC_UNUSED_TEXT" },
      backup: { vendor: "ark", model: "unused-text-backup", apiKey: "PUBLIC_UNUSED_BACKUP" },
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
type Scope = ReturnType<typeof createDomesticLlm>;
type Part = { type: string; text?: string; image_url?: { url: string } };
type Wire = {
  model: string;
  stream: boolean;
  response_format: unknown;
  messages: Array<{ role: string; content: string | Part[] }>;
};
type Sent = { url: string; init: RequestInit; body: Wire };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function envelope(value: unknown, fields: Record<string, unknown> = {}, finish = "stop") {
  return {
    choices: [
      {
        finish_reason: finish,
        message: { role: "assistant", content: JSON.stringify(value), ...fields },
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
  if (result.ok) throw new Error("Expected controlled failure");
  expect(Object.keys(result).sort()).toEqual(["message", "ok", "reason"]);
  expect(result.reason).toBe(reason);
  expect(result.message).not.toBe("");
  for (const secret of [
    image,
    "PUBLIC_IMAGE_SIGNATURE",
    "vendor-sensitive",
    "PUBLIC_VISION_PRIMARY",
    "PUBLIC_VISION_BACKUP",
    primaryUrl,
    backupUrl,
    vision().textInImage,
  ])
    expect(JSON.stringify(result)).not.toContain(secret);
}
function models(sent: Sent[], expected: string[]) {
  expect(sent.map((request) => request.body.model)).toEqual(expected);
  expect(sent.length).toBeLessThanOrEqual(3);
}
function images(sent: Sent) {
  const content = sent.body.messages[1]!.content;
  if (typeof content === "string") throw new Error("Vision requires actual image_url parts");
  return content.filter((part) => part.type === "image_url").map((part) => part.image_url!.url);
}
async function withHttp(
  reply: (response: ServerResponse, index: number, body: Wire) => unknown,
  run: (http: {
    sent: Sent[];
    bodies: Array<ReadableStream<Uint8Array>>;
    create(options?: DomesticLlmOptions, config?: DomesticLlmConfig): Scope;
  }) => Promise<void>,
) {
  const sent: Sent[] = [],
    bodies: Array<ReadableStream<Uint8Array>> = [],
    owned: Scope[] = [],
    errors: unknown[] = [];
  let received = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/vision");
      await reply(response, received++, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback not ready");
  const forwarding: typeof fetch = async (target, init) => {
    const url = String(target);
    if (![primaryUrl, backupUrl].includes(url) || !init || typeof init.body !== "string")
      throw new Error("Only fixed vision endpoints and JSON are allowed");
    sent.push({ url, init, body: JSON.parse(init.body) });
    const response = await nativeFetch(`http://127.0.0.1:${address.port}/vision`, init);
    if (response.body) bodies.push(response.body);
    return response;
  };
  try {
    await run({
      sent,
      bodies,
      create(options = {}, config = configuration()) {
        const scope = createDomesticLlm(config, { ...options, fetch: forwarding });
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

// Pure injected streams precede every native fetch, so timer0 measures only owned deadlines.
describe("analyzeVision bounded cleanup with an uncooperative transport", () => {
  it.each(["caller", "request", "total", "close", "http", "declared", "stream"] as const)(
    "never-settling cancel cannot hold %s, reader lock, timers or close",
    async (mode) => {
      vi.useFakeTimers();
      const cancellation = gate(),
        cancel = vi.fn(() => cancellation.promise),
        caller = new AbortController();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === "stream") controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        },
        cancel,
      });
      let calls = 0;
      const scope = createDomesticLlm(configuration(), {
        fetch: async () =>
          ++calls > 1
            ? new Response(JSON.stringify(envelope(minimum)))
            : new Response(stream, {
                status: mode === "http" ? 403 : 200,
                headers: mode === "declared" ? { "content-length": "1048577" } : {},
              }),
        timeoutMs: 10,
        totalTimeoutMs: mode === "total" ? 5 : 100,
      });
      let settled = false;
      let result: ProviderResult<LlmVision> | undefined;
      try {
        const work = scope.provider.analyzeVision({ ...input(), signal: caller.signal });
        void work.then((value) => {
          result = value;
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "caller") caller.abort();
        if (mode === "close") void scope.close();
        await vi.advanceTimersByTimeAsync(30);
        expect(settled).toBe(true);
        expect(cancel).toHaveBeenCalledOnce();
        expect(stream.locked).toBe(false);
        if (["request", "declared", "stream"].includes(mode)) {
          expect(result).toEqual({ ok: true, value: minimum });
          expect(calls).toBe(2);
        } else {
          if (!result) throw new Error("Cancellation must settle locally");
          safeFailure(result, mode === "http" ? "rejected" : "unavailable");
          expect(calls).toBe(1);
        }
        await scope.close();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        cancellation.release();
        await scope.close();
      }
    },
  );
  it.each(["body", "reader"] as const)(
    "synchronous %s cancel failure is consumed",
    async (mode) => {
      vi.useFakeTimers();
      const caller = new AbortController(),
        stream = new ReadableStream<Uint8Array>(),
        cancel = vi.fn(() => {
          throw new Error("vendor-sensitive");
        });
      if (mode === "body") vi.spyOn(stream, "cancel").mockImplementation(cancel);
      else vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel").mockImplementation(cancel);
      const scope = createDomesticLlm(configuration(), {
        fetch: async () => new Response(stream, { status: mode === "body" ? 403 : 200 }),
      });
      try {
        const work = scope.provider.analyzeVision({ ...input(), signal: caller.signal });
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "reader") caller.abort();
        safeFailure(await work, mode === "body" ? "rejected" : "unavailable");
        expect(cancel).toHaveBeenCalledOnce();
        expect(stream.locked).toBe(false);
        await scope.close();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await scope.close();
      }
    },
  );
  it("late cancel rejection is consumed after the caller and close have settled", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const cancellation = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const stream = new ReadableStream<Uint8Array>({ cancel: () => cancellation }),
      caller = new AbortController(),
      scope = createDomesticLlm(configuration(), { fetch: async () => new Response(stream) });
    try {
      const work = scope.provider.analyzeVision({ ...input(), signal: caller.signal });
      await vi.advanceTimersByTimeAsync(0);
      caller.abort();
      safeFailure(await work, "unavailable");
      expect(stream.locked).toBe(false);
      await scope.close();
      reject(new Error("vendor-sensitive"));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      reject(new Error("vendor-sensitive"));
      await scope.close();
    }
  });
  it("retains both the original 30s request and 60s total deadlines", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const scope = createDomesticLlm(configuration(), {
      fetch: async (_target, init) => {
        signals.push(init!.signal as AbortSignal);
        return new Promise<Response>(() => {});
      },
    });
    let settled = false;
    try {
      const work = scope.provider.analyzeVision(input());
      void work.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(signals).toHaveLength(1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0]!.aborted).toBe(true);
      expect(signals).toHaveLength(2);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      safeFailure(await work, "unavailable");
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      await scope.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await scope.close();
    }
  });
  it.each(["resolve", "reject"] as const)(
    "late fetch %s after caller cancellation cannot revive the call or leak rejection",
    async (mode) => {
      vi.useFakeTimers();
      let resolve!: (response: Response) => void;
      let reject!: (error: Error) => void;
      const transfer = new Promise<Response>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const caller = new AbortController(),
        cancel = vi.fn(async () => {}),
        stream = new ReadableStream<Uint8Array>({ cancel }),
        transport = vi.fn<typeof fetch>(() => transfer),
        scope = createDomesticLlm(configuration(), { fetch: transport });
      try {
        const work = scope.provider.analyzeVision({ ...input(), signal: caller.signal });
        await vi.advanceTimersByTimeAsync(0);
        expect(transport).toHaveBeenCalledOnce();
        caller.abort();
        safeFailure(await work, "unavailable");
        await scope.close();
        if (mode === "resolve") resolve(new Response(stream));
        else reject(new Error("vendor-sensitive"));
        await vi.advanceTimersByTimeAsync(0);
        expect(cancel).toHaveBeenCalledTimes(mode === "resolve" ? 1 : 0);
        expect(stream.locked).toBe(false);
        expect(transport).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        reject(new Error("vendor-sensitive"));
        await scope.close();
      }
    },
  );
  it("accepts exactly 1MiB of actual response bytes and releases its reader", async () => {
    vi.useFakeTimers();
    const content = JSON.stringify(envelope(vision())),
      bytes = content + " ".repeat(1024 * 1024 - Buffer.byteLength(content)),
      response = new Response(bytes, { headers: { "content-length": "1048576" } }),
      transport = vi.fn<typeof fetch>(async () => response),
      scope = createDomesticLlm(configuration(), { fetch: transport });
    try {
      expect(Buffer.byteLength(bytes)).toBe(1024 * 1024);
      expect(await scope.provider.analyzeVision(input())).toEqual({ ok: true, value: vision() });
      expect(transport).toHaveBeenCalledOnce();
      expect(response.body!.locked).toBe(false);
      await scope.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await scope.close();
    }
  });
  it.each([200, 403])(
    "success or HTTP %i clears both owned timers and caller listener",
    async (status) => {
      vi.useFakeTimers();
      const caller = new AbortController(),
        add = vi.spyOn(caller.signal, "addEventListener"),
        remove = vi.spyOn(caller.signal, "removeEventListener");
      const scope = createDomesticLlm(configuration(), {
        fetch: async () => new Response(JSON.stringify(envelope(vision())), { status }),
      });
      try {
        const result = await scope.provider.analyzeVision({ ...input(), signal: caller.signal });
        if (status === 200) expect(result).toEqual({ ok: true, value: vision() });
        else safeFailure(result, "rejected");
        expect(add).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
        expect(vi.getTimerCount()).toBe(0);
        expect(caller.signal.aborted).toBe(false);
      } finally {
        await scope.close();
      }
    },
  );
});

describe("vision five-field DTO and raw input bounds", () => {
  it("requires all five fields, preserves explicit empty facts, and does not invent frames", () => {
    expect(LlmVisionSchema.parse(minimum)).toEqual(minimum);
    expect(LlmVisionSchema.parse(vision())).toEqual(vision());
    expect(Object.keys(LlmVisionSchema.parse(minimum)).sort()).toEqual(Object.keys(minimum).sort());
  });
  it.each(Object.keys(minimum))("missing %s is rejected rather than defaulted", (key) => {
    const missing = Object.fromEntries(Object.entries(vision()).filter(([name]) => name !== key));
    expect(LlmVisionSchema.safeParse(missing).success).toBe(false);
  });
  it.each([
    { key: "description", value: 1 },
    { key: "quality", value: false },
    { key: "textInImage", value: [] },
    { key: "hasPeople", value: "true" },
    { key: "hasPeople", value: 1 },
    { key: "identifiableCustomerFace", value: "false" },
    { key: "identifiableCustomerFace", value: 0 },
  ])("does not coerce $key=$value", ({ key, value }) => {
    expect(LlmVisionSchema.safeParse({ ...vision(), [key]: value }).success).toBe(false);
  });
  it.each(Object.keys(minimum))("null %s is not an explicit valid fact", (key) => {
    expect(LlmVisionSchema.safeParse({ ...vision(), [key]: null }).success).toBe(false);
  });
  it.each(["frames", "tags", "personName", "url"])("rejects model-invented %s", (key) => {
    expect(LlmVisionSchema.safeParse({ ...vision(), [key]: [] }).success).toBe(false);
  });
  it.each([
    { key: "description", max: 2000 },
    { key: "quality", max: 500 },
    { key: "textInImage", max: 8000 },
  ])("$key uses Unicode code points at the exact bound", ({ key, max }) => {
    for (const unit of ["菜", "🍜"]) {
      const accepted = { ...minimum, [key]: unit.repeat(max) };
      expect(LlmVisionSchema.parse(accepted)).toEqual(accepted);
      expect(LlmVisionSchema.safeParse({ ...minimum, [key]: unit.repeat(max + 1) }).success).toBe(
        false,
      );
    }
  });
  it.each([false, true])("both actual booleans=%s are preserved without inference", (flag) => {
    const value = { ...minimum, hasPeople: flag, identifiableCustomerFace: flag };
    expect(LlmVisionSchema.parse(value)).toEqual(value);
  });
  it.each([
    { value: null },
    { value: undefined },
    { value: [] },
    { value: "image" },
    { value: {} },
    { value: { imageUrls: null } },
    { value: { imageUrls: image } },
    { value: { imageUrls: [] } },
    { value: { imageUrls: Array.from({ length: 15 }, () => image) } },
    { value: { imageUrls: [null] } },
    { value: { imageUrls: [42] } },
    { value: { imageUrls: [""] } },
    { value: { imageUrls: ["http://example.invalid/x"] } },
    { value: { imageUrls: ["data:image/png;base64,AA=="] } },
    { value: { imageUrls: ["file:///tmp/image"] } },
    { value: { imageUrls: ["https://name:password@example.invalid/x"] } },
    { value: { imageUrls: ["https://example.invalid/x#private-fragment"] } },
    { value: { imageUrls: ["not a URL"] } },
    { value: { imageUrls: ["https://example.invalid/x\n"] } },
    { value: { imageUrls: [" https://example.invalid/x"] } },
    { value: { imageUrls: [image], frames: [] } },
    { value: { imageUrls: [image], signal: null } },
    { value: { imageUrls: [image], signal: {} } },
  ])("invalid raw image input $value performs zero HTTP", async ({ value }) => {
    expect(prepareVision(value)).toBeUndefined();
    const transport = vi.fn<typeof fetch>();
    const scope = createDomesticLlm(configuration(), { fetch: transport });
    try {
      safeFailure(await scope.provider.analyzeVision(value as LlmVisionInput), "rejected");
      expect(transport).not.toHaveBeenCalled();
    } finally {
      await scope.close();
    }
  });
  it("URL limit counts UTF8 bytes including the complete signature query", () => {
    const prefix = "https://example.invalid/x?signature=";
    for (const unit of ["a", "菜", "🍜"]) {
      const room = 8192 - Buffer.byteLength(prefix),
        count = Math.floor(room / Buffer.byteLength(unit)),
        url = prefix + unit.repeat(count) + "a".repeat(room % Buffer.byteLength(unit));
      expect(Buffer.byteLength(url)).toBe(8192);
      expect(prepareVision({ imageUrls: [url] })).toBeDefined();
      expect(prepareVision({ imageUrls: [url + "a"] })).toBeUndefined();
    }
  });
  it("raw aggregate is bounded independently of the 14-item and per-URL limits", () => {
    const prefix = "https://example.invalid/x?signature=";
    const long = prefix + "a".repeat(8192 - Buffer.byteLength(prefix));
    expect(prepareVision({ imageUrls: Array.from({ length: 7 }, () => long) })).toBeDefined();
    expect(prepareVision({ imageUrls: Array.from({ length: 8 }, () => long) })).toBeUndefined();
  });
  it("the exact 64KiB bound includes fixed text and every image_url wrapper", () => {
    const prefix = "https://example.invalid/x?sig=",
      urls = Array.from({ length: 8 }, () => prefix);
    const initial = prepareVision({ imageUrls: urls });
    if (!initial) throw new Error("Small valid input should prepare");
    let room = 65536 - Buffer.byteLength(JSON.stringify(initial.content));
    for (let index = 0; index < urls.length && room > 0; index++) {
      const add = Math.min(room, 8192 - Buffer.byteLength(urls[index]!));
      urls[index] += "a".repeat(add);
      room -= add;
    }
    expect(room).toBe(0);
    const prepared = prepareVision({ imageUrls: urls });
    expect(prepared).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(prepared!.content))).toBe(65536);
    const last = urls.length - 1;
    expect(Buffer.byteLength(urls[last]!)).toBeLessThan(8192);
    urls[last] += "a";
    expect(prepareVision({ imageUrls: urls })).toBeUndefined();
    expect(prepared!.parse(vision())).toEqual(vision());
    expect(prepared!.parse({ ...vision(), frames: [] })).toBeUndefined();
  });
});

describe("analyzeVision real loopback wire, immutable images and bounded primary/backup", () => {
  it.each([1, 14])(
    "sends all %i URLs in order with only fixed vision JSON endpoints",
    async (count) => {
      const urls = Array.from(
        { length: count },
        (_, index) => `https://assets.example.invalid/frame-${index}.jpg?sig=PUBLIC_${index}`,
      );
      await withHttp(
        (response) => json(response, envelope(vision())),
        async (http) => {
          const result = await http.create().provider.analyzeVision({ imageUrls: urls });
          expect(result).toEqual({ ok: true, value: vision() });
          models(http.sent, ["vision-primary"]);
          const sent = http.sent[0]!;
          expect(sent.url).toBe(primaryUrl);
          expect(sent.init).toMatchObject({ method: "POST", redirect: "error" });
          expect(new Headers(sent.init.headers).get("authorization")).toBe(
            "Bearer PUBLIC_VISION_PRIMARY",
          );
          expect(new Headers(sent.init.headers).get("content-type")).toBe("application/json");
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
          const system = sent.body.messages[0]!.content;
          expect(typeof system).toBe("string");
          for (const key of Object.keys(minimum)) expect(system).toContain(key);
          expect(system).toContain("Do not identify people");
          expect(images(sent)).toEqual(urls);
          expect(sent.body.messages[1]!.content).toHaveLength(count + 1);
          expect(http.bodies.every((body) => !body.locked)).toBe(true);
        },
      );
    },
  );
  it("snapshots caller image order and both endpoints before later mutation", async () => {
    const urls = [image, "https://assets.example.invalid/second.jpg"],
      original = [...urls],
      config = configuration();
    await withHttp(
      (response, index) =>
        index === 0
          ? json(response, { error: "vendor-sensitive" }, 503)
          : json(response, envelope(vision())),
      async (http) => {
        const scope = http.create({}, config);
        const pending = scope.provider.analyzeVision({ imageUrls: urls });
        urls.reverse();
        urls[0] = "https://assets.example.invalid/changed.jpg";
        config.vision.primary.model = "changed-primary";
        config.vision.backup.model = "changed-backup";
        config.vision.backup.apiKey = "CHANGED_PUBLIC_BACKUP";
        expect(await pending).toEqual({ ok: true, value: vision() });
        models(http.sent, ["vision-primary", "vision-backup"]);
        expect(http.sent.map(images)).toEqual([original, original]);
        expect(new Headers(http.sent[1]!.init.headers).get("authorization")).toBe(
          "Bearer PUBLIC_VISION_BACKUP",
        );
      },
    );
  });
  it.each(["primary-repair-backup", "backup-repair"] as const)(
    "%s keeps one global schema repair and at most three requests",
    async (mode) => {
      await withHttp(
        (response, index) => {
          if (mode === "backup-repair" && index === 0)
            json(response, { error: "vendor-sensitive" }, 503);
          else
            json(response, envelope(index === 2 ? vision() : { description: "vendor-sensitive" }));
        },
        async (http) => {
          expect(await http.create().provider.analyzeVision(input())).toEqual({
            ok: true,
            value: vision(),
          });
          models(
            http.sent,
            mode === "backup-repair"
              ? ["vision-primary", "vision-backup", "vision-backup"]
              : ["vision-primary", "vision-primary", "vision-backup"],
          );
          const repairs = http.sent.filter((request) =>
            (request.body.messages[0]!.content as string).includes("previous output"),
          );
          expect(repairs).toHaveLength(1);
          for (const request of http.sent) {
            expect(images(request)).toEqual([image]);
            expect(JSON.stringify(request.body)).not.toContain("vendor-sensitive");
            expect(request.body.messages[1]!.content).toEqual(
              http.sent[0]!.body.messages[1]!.content,
            );
          }
          expect(http.sent.at(-1)!.url).toBe(backupUrl);
        },
      );
    },
  );
  it("persistent malformed output stops after three requests without defaults or fake success", async () => {
    await withHttp(
      (response) => json(response, envelope({ description: "vendor-sensitive" })),
      async (http) => {
        safeFailure(await http.create().provider.analyzeVision(input()), "unavailable");
        models(http.sent, ["vision-primary", "vision-primary", "vision-backup"]);
      },
    );
  });
  it.each([408, 429, 500, 503])(
    "HTTP %i switches once to the fixed vision backup",
    async (status) => {
      await withHttp(
        (response, index) =>
          index === 0
            ? json(response, { error: "vendor-sensitive" }, status)
            : json(response, envelope(minimum)),
        async (http) => {
          expect(await http.create().provider.analyzeVision(input())).toEqual({
            ok: true,
            value: minimum,
          });
          models(http.sent, ["vision-primary", "vision-backup"]);
          expect(http.sent[1]!.url).toBe(backupUrl);
        },
      );
    },
  );
  it.each([400, 401, 403, 422])(
    "HTTP %i immediately fails without repair or backup",
    async (status) => {
      await withHttp(
        (response) => json(response, { error: `vendor-sensitive ${image}` }, status),
        async (http) => {
          safeFailure(await http.create().provider.analyzeVision(input()), "rejected");
          models(http.sent, ["vision-primary"]);
        },
      );
    },
  );
  it.each([
    { label: "refusal", fields: { refusal: "vendor-sensitive" } },
    { label: "tool", fields: { tool_calls: [{ name: "vendor-sensitive" }] } },
    { label: "function", fields: { function_call: { name: "vendor-sensitive" } } },
  ])("explicit $label is a controlled refusal, not repair input", async ({ fields }) => {
    await withHttp(
      (response) => json(response, envelope(vision(), fields)),
      async (http) => {
        safeFailure(await http.create().provider.analyzeVision(input()), "rejected");
        models(http.sent, ["vision-primary"]);
      },
    );
  });
  it.each(["network", "utf8", "declared", "chunked", "choice", "length"] as const)(
    "invalid %s transport/envelope falls back once and releases both readers",
    async (mode) => {
      await withHttp(
        (response, index) => {
          if (index > 0) return json(response, envelope(minimum));
          if (mode === "network") return response.destroy();
          if (mode === "utf8") return response.end(Buffer.from([0xff, 0xfe]));
          if (mode === "declared") {
            response.writeHead(200, { "content-length": "1048577" });
            return response.end("vendor-sensitive");
          }
          if (mode === "chunked") {
            response.writeHead(200);
            response.write(Buffer.alloc(600_000, 32));
            return response.end(Buffer.alloc(600_000, 32));
          }
          return json(
            response,
            mode === "choice" ? { choices: [] } : envelope(vision(), {}, "length"),
          );
        },
        async (http) => {
          expect(await http.create().provider.analyzeVision(input())).toEqual({
            ok: true,
            value: minimum,
          });
          models(http.sent, ["vision-primary", "vision-backup"]);
          expect(http.bodies.every((body) => !body.locked)).toBe(true);
        },
      );
    },
  );
});

describe("analyzeVision caller cancellation, streaming cleanup and instance ownership", () => {
  it("pre-aborted caller performs zero HTTP and remains aborted", async () => {
    const caller = new AbortController(),
      transport = vi.fn<typeof fetch>();
    caller.abort();
    const scope = createDomesticLlm(configuration(), { fetch: transport });
    try {
      safeFailure(
        await scope.provider.analyzeVision({ ...input(), signal: caller.signal }),
        "unavailable",
      );
      expect(transport).not.toHaveBeenCalled();
      expect(caller.signal.aborted).toBe(true);
    } finally {
      await scope.close();
    }
  });
  it.each(["caller", "request", "total", "close"] as const)(
    "real HTTP partial stream %s is bounded with no reader left locked",
    async (mode) => {
      const arrived = gate();
      await withHttp(
        (response, index) => {
          if (index > 0) return json(response, envelope(minimum));
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
          const pending = scope.provider.analyzeVision({ ...input(), signal: caller.signal });
          await Promise.race([
            arrived.promise,
            pending.then(() => {
              throw new Error("Call ended before real HTTP arrival");
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
          if (mode === "request") expect(result).toEqual({ ok: true, value: minimum });
          else safeFailure(result, "unavailable");
          models(
            http.sent,
            mode === "request" ? ["vision-primary", "vision-backup"] : ["vision-primary"],
          );
          expect(http.sent[0]!.init.signal?.aborted).toBe(true);
          expect(http.bodies.every((body) => !body.locked)).toBe(true);
          expect(caller.signal.aborted).toBe(mode === "caller");
        },
      );
    },
  );
  it("caller cancellation affects only its call; close affects only its own instance", async () => {
    const arrived = gate();
    let waiting = 0;
    await withHttp(
      (response, index) => {
        if (index >= 2) return json(response, envelope(minimum));
        if (++waiting === 2) arrived.release();
      },
      async (http) => {
        const first = http.create(),
          second = http.create(),
          caller = new AbortController();
        const a = first.provider.analyzeVision({ ...input(), signal: caller.signal }),
          b = first.provider.analyzeVision(input());
        await Promise.race([
          arrived.promise,
          Promise.all([a, b]).then(() => {
            throw new Error("Calls ended before real HTTP arrival");
          }),
        ]);
        caller.abort();
        safeFailure(await a, "unavailable");
        expect(http.sent[1]!.init.signal?.aborted).toBe(false);
        await first.close();
        safeFailure(await b, "unavailable");
        expect(await second.provider.analyzeVision(input())).toEqual({ ok: true, value: minimum });
        safeFailure(await first.provider.analyzeVision(input()), "unavailable");
        models(http.sent, ["vision-primary", "vision-primary", "vision-primary"]);
        await first.close();
      },
    );
  });
});

describe("analyzeVision defaults, fake queue isolation and outer IO guard", () => {
  it("default production factory remains unconfigured with the fourth method present", async () => {
    const provider = createProviders({
      appEnv: "prod",
      logger: createRecordingLogger(),
      beforeCall: () => {},
    }).llm;
    expect(provider.status).toBe("unconfigured");
    expect(provider.configured).toBe(false);
    safeFailure(await provider.analyzeVision(input()), "unconfigured");
  });
  it("visionReplies is independent of all three old method queues and returned objects", async () => {
    const fake = createFakeLlm(),
      original = vision();
    fake.visionReplies.push(original, minimum);
    fake.tagReplies.push({ description: "旧打标", tags: ["旧标签"] });
    fake.keyPointReplies.push(["旧要点"]);
    const digest = {
      title: "旧结构化摘要",
      keypoints: [],
      contentTags: [],
      suggestedUsage: [],
      faceHint: "none" as const,
      qualityNotes: [],
    };
    fake.digestReplies.push(digest);
    const result = await fake.analyzeVision(input());
    expect(result).toEqual({ ok: true, value: original });
    if (!result.ok) throw new Error("Fake should succeed");
    result.value.description = "修改返回值";
    expect(original).toEqual(vision());
    expect(fake.tagReplies).toHaveLength(1);
    expect(fake.keyPointReplies).toHaveLength(1);
    expect(fake.digestReplies).toEqual([digest]);
    expect(await fake.tagAsset({ kind: "image", url: image })).toEqual({
      ok: true,
      value: { description: "旧打标", tags: ["旧标签"] },
    });
    expect(await fake.extractKeyPoints({ text: "旧文本" })).toEqual({
      ok: true,
      value: { points: ["旧要点"] },
    });
    expect(
      await fake.summarizeAsset({
        text: "旧文本",
        vocabulary: { content: [], usage: [], timeliness: [] },
      }),
    ).toEqual({ ok: true, value: digest });
    expect(await fake.analyzeVision(input())).toEqual({ ok: true, value: minimum });
    expect(fake.visionReplies).toEqual([]);
    expect(fake.calls.map((call) => call.method)).toEqual([
      "analyzeVision",
      "tagAsset",
      "extractKeyPoints",
      "summarizeAsset",
      "analyzeVision",
    ]);
  });
  it("fake default is explicitly synthetic, complete and independently copied", async () => {
    const fake = createFakeLlm(),
      a = await fake.analyzeVision(input()),
      b = await fake.analyzeVision(input());
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
    if (!a.ok || !b.ok) throw new Error("Synthetic default should succeed");
    expect(LlmVisionSchema.safeParse(a.value).success).toBe(true);
    expect(a.value.description).toContain("虚构");
    a.value.textInImage = "修改返回值";
    expect(b.value.textInImage).not.toBe("修改返回值");
  });
  it("fake preabort and injected failure do not consume vision or old queues", async () => {
    const fake = createFakeLlm(),
      caller = new AbortController();
    fake.visionReplies.push(vision());
    fake.tagReplies.push({ description: "旧样例", tags: [] });
    caller.abort();
    safeFailure(await fake.analyzeVision({ ...input(), signal: caller.signal }), "unavailable");
    fake.failNext("analyzeVision");
    safeFailure(await fake.analyzeVision(input()), "unavailable");
    expect(fake.visionReplies).toEqual([vision()]);
    expect(fake.tagReplies).toHaveLength(1);
    expect(await fake.analyzeVision(input())).toEqual({ ok: true, value: vision() });
    expect(fake.pendingCalls()).toBe(0);
  });
  it("fake delayed abort removes its pending call and listener without a later tick", async () => {
    const clock = createClock(),
      fake = createFakeLlm({ clock }),
      caller = new AbortController(),
      remove = vi.spyOn(caller.signal, "removeEventListener");
    fake.delayNext("analyzeVision", 1000);
    const pending = fake.analyzeVision({ ...input(), signal: caller.signal });
    expect(fake.pendingCalls()).toBe(1);
    caller.abort();
    safeFailure(await pending, "unavailable");
    expect(fake.pendingCalls()).toBe(0);
    expect(remove).toHaveBeenCalled();
    clock.advance(1000);
    expect(fake.tick()).toBe(0);
  });
  it.each(["fake", "domestic"] as const)(
    "%s fourth method remains behind beforeCall",
    async (mode) => {
      await withHttp(
        (response) => json(response, envelope(minimum)),
        async (http) => {
          const fake = createFakeLlm(),
            denied = new Error("Controlled outer IO denial"),
            before = vi.fn(() => {
              throw denied;
            });
          fake.visionReplies.push(vision());
          const provider = withBeforeCall(
            "llm",
            mode === "fake" ? fake : http.create().provider,
            before,
          );
          await expect(provider.analyzeVision(input())).rejects.toBe(denied);
          expect(before).toHaveBeenCalledExactlyOnceWith({
            provider: "llm",
            method: "analyzeVision",
          });
          expect(http.sent).toEqual([]);
          expect(fake.calls).toEqual([]);
          expect(fake.visionReplies).toEqual([vision()]);
        },
      );
    },
  );
});
