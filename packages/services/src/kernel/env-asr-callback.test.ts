import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleProviders } from "./index.js";
import { APP_ENVS, EnvError, loadEnv } from "./env.js";
import type { Env, EnvSource } from "./env.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    openSync: vi.fn(original.openSync),
    readSync: vi.fn(original.readSync),
    closeSync: vi.fn(original.closeSync),
  };
});

const origin = "https://callbacks.example.com";
const key = "0123456789abcdef0123456789abcdef";
const asr = { secretId: "public_fake_asr_id", secretKey: "public-fake-asr-secret" };
const mediaJobId = "01960000-0000-7000-8000-000000000001";
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
let directory: string;
let sequence = 0;
let fifo: string;
let base: EnvSource;
let configured: EnvSource;
const closers: Array<() => Promise<void>> = [];

function file(content: string | Uint8Array): string {
  const path = join(directory, `public-callback-${sequence++}`);
  fs.writeFileSync(path, content);
  return path;
}
function source(content: string | Uint8Array = key, callbackOrigin = origin): EnvSource {
  return {
    ...configured,
    ASR_CALLBACK_ORIGIN: callbackOrigin,
    ASR_CALLBACK_KEY_FILE: file(content),
  };
}
function failure(input: EnvSource): EnvError {
  try {
    loadEnv(input);
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error("非法回调配置意外通过");
}
function redacted(error: EnvError): void {
  const text = `${error.message}\n${JSON.stringify(error.issues)}`;
  for (const value of [directory, origin, key, asr.secretId, asr.secretKey, "private-marker"])
    expect(text).not.toContain(value);
}
function driver(callback: Env["ASR_CALLBACK"]) {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ Response: { RequestId: "public-request", Data: { TaskId: 1 } } }),
      ),
  );
  const providers = assembleProviders({
    appEnv: "prod",
    logger,
    settings: { asr },
    asr: {
      callback,
      now: () => new Date("2026-10-12T00:00:00.000Z"),
      fetch: transport,
      registerClose: (close) => closers.push(close),
    },
  });
  return { provider: providers.asr, transport };
}

beforeAll(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "lyx-asr-callback-env-"));
  base = {
    APP_ENV: "test",
    DATABASE_URL_FILE: file("postgresql://public:public@localhost/lyx_test_public"),
    REDIS_URL_FILE: file("redis://localhost:6379"),
  };
  configured = { ...base, ASR_TENCENT_FILE: file(JSON.stringify(asr)) };
  fifo = join(directory, "public-fifo");
  execFileSync("mkfifo", [fifo]);
});
beforeEach(() => {
  vi.mocked(fs.openSync).mockClear();
  vi.mocked(fs.readSync).mockClear();
  vi.mocked(fs.closeSync).mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("配置不应联网"))),
  );
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fs.openSync).mockReset();
  vi.mocked(fs.readSync).mockReset();
  vi.mocked(fs.closeSync).mockReset();
  vi.unstubAllGlobals();
});
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

describe.each(APP_ENVS)("ASR callback FILE 在 %s", (APP_ENV) => {
  it("全无保持关闭，不制造origin、key或真实驱动", () => {
    const env = loadEnv({ ...base, APP_ENV });
    expect(env).not.toHaveProperty("ASR_CALLBACK");
    expect(env).not.toHaveProperty("ASR_TENCENT");
    expect(assembleProviders({ appEnv: "prod", logger }).asr.status).toBe("unconfigured");
  });
  it("独立完整FILE与真实ASR配置成对，返回配置冻结", () => {
    const input = { ...source(), APP_ENV };
    const env = loadEnv(input);
    expect(env.ASR_TENCENT).toEqual(asr);
    expect(env.ASR_CALLBACK).toEqual({ origin, key });
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.ASR_CALLBACK)).toBe(true);
    expect(JSON.stringify(env)).not.toContain(directory);
    expect(Reflect.set(env.ASR_CALLBACK!, "key", "replacement")).toBe(false);
  });
  it.each(["private-marker", "", " \t\n"])("拒绝明文键，即使FILE齐全：%j", (plain) => {
    const error = failure({ ...source(), APP_ENV, ASR_CALLBACK_KEY: plain });
    expect(error.issues.map((issue) => issue.key)).toEqual(["ASR_CALLBACK_KEY"]);
    redacted(error);
  });
});

describe("配对与独立配置边界", () => {
  it("只有原ASR配置不启用回调；空白两键仍缺省", () => {
    expect(loadEnv(configured)).not.toHaveProperty("ASR_CALLBACK");
    expect(
      loadEnv({ ...configured, ASR_CALLBACK_ORIGIN: " \n", ASR_CALLBACK_KEY_FILE: " " }),
    ).not.toHaveProperty("ASR_CALLBACK");
  });
  it.each(["origin", "key"])("缺少配对项 %s 拒绝，不能静默回退", (missing) => {
    const input = source();
    const error = failure({
      ...input,
      ...(missing === "origin"
        ? { ASR_CALLBACK_ORIGIN: undefined }
        : { ASR_CALLBACK_KEY_FILE: undefined }),
    });
    expect(error.issues.map((issue) => issue.key)).toEqual([
      missing === "origin" ? "ASR_CALLBACK_ORIGIN" : "ASR_CALLBACK_KEY_FILE",
    ]);
    redacted(error);
  });
  it.each([undefined, "", " \n"])("缺真实ASR配置 %j 明确拒绝", (path) => {
    const error = failure({ ...source(), ASR_TENCENT_FILE: path });
    expect(error.issues.map((issue) => issue.key)).toEqual(["ASR_TENCENT_FILE"]);
    redacted(error);
  });
  it("非法ASR FILE不能被合法callback补成真实配置", () => {
    const error = failure({ ...source(), ASR_TENCENT_FILE: file('{"private-marker":true}') });
    expect(error.issues.every((issue) => issue.key === "ASR_TENCENT_FILE")).toBe(true);
    redacted(error);
  });
  it("不借CI密钥或model JSON内的callback字段", () => {
    const error = failure({
      ...source(),
      ASR_TENCENT_FILE: file(JSON.stringify({ ...asr, callback: { origin, key } })),
    });
    expect(error.issues.some((issue) => issue.key === "ASR_TENCENT_FILE")).toBe(true);
    const onlyKey = failure({ ...configured, ASR_CALLBACK_ORIGIN: origin });
    expect(onlyKey.issues.map((issue) => issue.key)).toEqual(["ASR_CALLBACK_KEY_FILE"]);
    redacted(error);
    redacted(onlyKey);
  });
  it("解析后输入与文件变更不改已冻结的独立快照", () => {
    const input = { ...source() };
    const env = loadEnv(input);
    input.ASR_CALLBACK_ORIGIN = "https://other.example.com";
    fs.writeFileSync(input.ASR_CALLBACK_KEY_FILE!, "b".repeat(32));
    expect(env.ASR_CALLBACK).toEqual({ origin, key });
    const next = loadEnv(input);
    expect(next.ASR_CALLBACK).toEqual({ origin: input.ASR_CALLBACK_ORIGIN, key: "b".repeat(32) });
    expect(next.ASR_CALLBACK).not.toBe(env.ASR_CALLBACK);
  });
});

describe("原始UTF8文件与关闭边界", () => {
  it.each([
    ["ASCII32", key],
    ["ASCII256", "a".repeat(256)],
    ["多字节32", "密钥".repeat(5) + "ab"],
    ["多字节256", "密钥".repeat(42) + "abcd"],
    ["组合字符", "e\u0301".repeat(11)],
    ["不trim空格", " ".repeat(32)],
    ["不trim换行", "\n" + "a".repeat(31)],
    ["保留BOM", "\ufeff" + "a".repeat(29)],
    ["保留NUL", "\0".repeat(32)],
    ["不解码hex", "a1".repeat(32)],
    ["不解码base64", "YWJj".repeat(11)],
  ])("%s按原字节保存，不裁剪或规范化", (_name, value) => {
    const bytes = Buffer.from(value);
    expect(bytes.length).toBeGreaterThanOrEqual(32);
    expect(bytes.length).toBeLessThanOrEqual(256);
    const env = loadEnv(source(bytes));
    expect(env.ASR_CALLBACK?.key).toBe(value);
    expect(Buffer.from(env.ASR_CALLBACK!.key)).toEqual(bytes);
  });
  it.each([
    ["空", Buffer.alloc(0)],
    ["31", Buffer.alloc(31, 97)],
    ["257", Buffer.alloc(257, 97)],
    ["多字节31", Buffer.from("密".repeat(10) + "a")],
    ["多字节257", Buffer.from("密".repeat(85) + "ab")],
    ["截断UTF8", Buffer.concat([Buffer.alloc(31, 97), Buffer.from([0xe4, 0xb8])])],
    ["非法续字节", Buffer.concat([Buffer.alloc(31, 97), Buffer.from([0x80])])],
    ["过长编码", Buffer.concat([Buffer.alloc(30, 97), Buffer.from([0xc0, 0xaf])])],
    ["UTF8代理区", Buffer.concat([Buffer.alloc(30, 97), Buffer.from([0xed, 0xa0, 0x80])])],
    [
      "超过Unicode上限",
      Buffer.concat([Buffer.alloc(30, 97), Buffer.from([0xf4, 0x90, 0x80, 0x80])]),
    ],
  ])("%s实际字节或fatal UTF8不合法时受控失败", (_name, value) => {
    const error = failure(source(value));
    expect(error.issues.map((issue) => issue.key)).toEqual(["ASR_CALLBACK_KEY_FILE"]);
    redacted(error);
  });
  it.each(["missing", "directory", "fifo"])("%s不是可读普通文件，非阻塞且描述符关闭", (kind) => {
    const path =
      kind === "missing"
        ? join(directory, "private-marker-missing")
        : kind === "directory"
          ? directory
          : fifo;
    const error = failure({ ...source(), ASR_CALLBACK_KEY_FILE: path });
    expect(error.issues.map((issue) => issue.key)).toEqual(["ASR_CALLBACK_KEY_FILE"]);
    const opened = vi.mocked(fs.openSync).mock.results.filter((result) => result.type === "return");
    expect(vi.mocked(fs.closeSync).mock.calls.map(([fd]) => fd)).toEqual(
      opened.map((result) => result.value),
    );
    redacted(error);
  });
  it("reader最多申请257字节；实际成功与失败均只close每个FD一次", () => {
    const env = loadEnv(source("a".repeat(256)));
    expect(env.ASR_CALLBACK?.key).toHaveLength(256);
    const reads = vi.mocked(fs.readSync).mock.calls;
    expect(reads.some((call) => call[1].byteLength === 257)).toBe(true);
    const opened = vi.mocked(fs.openSync).mock.results.filter((result) => result.type === "return");
    const closed = vi.mocked(fs.closeSync).mock.calls.map(([fd]) => fd);
    expect(closed).toEqual(opened.map((result) => result.value));
  });
  it("独立key reader抛错仍finally关闭，不透传原异常", () => {
    vi.mocked(fs.readSync).mockImplementationOnce(() => {
      throw new Error("private-marker");
    });
    const error = failure({
      ...base,
      ASR_CALLBACK_ORIGIN: origin,
      ASR_CALLBACK_KEY_FILE: file(key),
    });
    expect(error.issues.some((issue) => issue.key === "ASR_CALLBACK_KEY_FILE")).toBe(true);
    expect(fs.closeSync).toHaveBeenCalledTimes(1);
    redacted(error);
  });
  it("key close抛错明确失败且已真实关闭，不吞诊断", () => {
    const original = vi.mocked(fs.closeSync).getMockImplementation()!;
    vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
      original(fd);
      throw new Error("private-marker");
    });
    const error = failure({
      ...base,
      ASR_CALLBACK_ORIGIN: origin,
      ASR_CALLBACK_KEY_FILE: file(key),
    });
    expect(error.issues).toContainEqual({
      key: "ASR_CALLBACK_KEY_FILE",
      reason: "配置文件关闭失败",
    });
    expect(fs.closeSync).toHaveBeenCalledTimes(1);
    redacted(error);
  });
});

describe("origin与已接受公开factory的严格等价", () => {
  it.each([origin, `${origin}/`, `${origin}:443`, `${origin}:443/`, "https://xn--fsqu00a.com"])(
    "接受同一origin %s且只规范根与443",
    (value) => {
      const env = loadEnv(source(key, value));
      expect(env.ASR_CALLBACK?.origin).toBe(new URL(value).origin);
      expect(driver({ origin: value, key }).provider.configured).toBe(true);
    },
  );
  it.each([
    "http://callbacks.example.com",
    "HTTPS://callbacks.example.com",
    "https://Callbacks.example.com",
    "https://user:private-marker@callbacks.example.com",
    "https://callbacks.example.com:444",
    "https://callbacks.example.com/path",
    "https://callbacks.example.com//",
    "https://callbacks.example.com?",
    "https://callbacks.example.com#",
    "https://callbacks%2eexample.com",
    "https://例子.com",
    "https://127.0.0.1",
    "https://[::1]",
    "https://127.1",
    "https://localhost",
    "https://api.local",
    "https://api.localhost",
    "https://api.internal",
    "https://api.onion",
    "https://api.invalid",
    "https://api.test",
    "https://api.123",
    "https://api.0x123",
    "https://-api.example.com",
    "https://api-.example.com",
    "https://api..example.com",
    "https://api.example.com.",
    " https://api.example.com",
    "https://api.example.com\n",
    "https://api.exa\tmple.com",
    "https://api.example.com\u007f",
    "https://api.example.com\\",
    `https://${"a".repeat(64)}.com`,
    `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
  ])("拒绝同一非法origin %j且不回显", (value) => {
    const error = failure(source(key, value));
    expect(error.issues.map((issue) => issue.key)).toEqual(["ASR_CALLBACK_ORIGIN"]);
    expect(() => driver({ origin: value, key })).toThrow(TypeError);
    redacted(error);
    expect(String(error)).not.toContain(value);
  });
  it("完整253字节DNS及266字节origin上界与公开factory一致", () => {
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    const value = `https://${host}:443/`;
    expect(host).toHaveLength(253);
    expect(value).toHaveLength(266);
    expect(loadEnv(source(key, value)).ASR_CALLBACK?.origin).toBe(`https://${host}`);
    expect(driver({ origin: value, key }).provider.configured).toBe(true);
  });
  it.each([
    ["ASCII固定向量", key, "Te8AxwzKLiZJsOeVld_9zXls7UG5pdDRXsXTPf-vPuA"],
    ["UTF8固定向量", "密钥".repeat(5) + "ab", "iHmOyPHgrqjLcZ0rPuI-ZV219wBXB8TyMSA4b-9Phus"],
    ["BOM原字节", "\ufeff" + "a".repeat(29), undefined],
    ["组合原字节", "e\u0301".repeat(11), undefined],
    ["换行原字节", "\n" + "a".repeat(31), undefined],
  ])("%s传入真实sender后签名仍消费完全相同原字节", async (_name, value, golden) => {
    const env = loadEnv(source(value));
    const owned = driver(env.ASR_CALLBACK);
    expect(owned.transport).not.toHaveBeenCalled();
    const result = await owned.provider.submit({
      url: "https://storage.example.com/public.mp3",
      callback: { mediaJobId },
    });
    expect(result.ok).toBe(true);
    expect(owned.transport).toHaveBeenCalledTimes(1);
    const [target, init] = owned.transport.mock.calls[0]!;
    expect(target).toBe("https://asr.tencentcloudapi.com/");
    const expected = createHmac("sha256", Buffer.from(value))
      .update(mediaJobId)
      .digest("base64url");
    if (golden !== undefined) expect(expected).toBe(golden);
    const payload = JSON.parse(String(init?.body)) as { CallbackUrl: string };
    expect(payload.CallbackUrl).toBe(
      `${origin}/api/v1/hooks/asr/media-jobs/${mediaJobId}?sig=${expected}`,
    );
    expect(init?.redirect).toBe("error");
  });
});
