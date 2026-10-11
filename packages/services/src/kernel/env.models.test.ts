import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_ENVS, EnvError, loadEnv } from "./env.js";
import type { EnvSource } from "./env.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    openSync: vi.fn(original.openSync),
    readSync: vi.fn(original.readSync),
    closeSync: vi.fn(original.closeSync),
  };
});

const asr = { secretId: "public_fake_asr_id", secretKey: "public-fake-asr-secret" };
const endpoint = { vendor: "ark", model: "public-model", apiKey: "public-fake-api-key" };
const llm = {
  text: {
    primary: endpoint,
    backup: { ...endpoint, vendor: "bailian", workspaceId: "public-workspace" },
  },
  vision: { primary: { ...endpoint, vendor: "deepseek" }, backup: endpoint },
};
const keys = ["ASR_TENCENT", "LLM_DOMESTIC"] as const;
const routes = [
  ["text", "primary"],
  ["text", "backup"],
  ["vision", "primary"],
  ["vision", "backup"],
] as const;
let directory: string;
let sequence = 0;
let base: EnvSource;
let configured: EnvSource;
let fifo: string;

function file(body: string): string {
  const path = join(directory, `public-config-${sequence++}.json`);
  fs.writeFileSync(path, body);
  return path;
}
function source(key: (typeof keys)[number], value: unknown): EnvSource {
  return { ...base, [`${key}_FILE`]: file(JSON.stringify(value)) };
}
function failure(input: EnvSource): EnvError {
  try {
    loadEnv(input);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return error as EnvError;
  }
  throw new Error("非法配置意外通过");
}
function redacted(error: EnvError): void {
  const text = `${error.message}\n${JSON.stringify(error.issues)}`;
  for (const marker of [
    directory,
    asr.secretId,
    asr.secretKey,
    endpoint.apiKey,
    "private-file-marker",
    "private-value-marker",
  ])
    expect(text).not.toContain(marker);
}

beforeAll(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "lyx-model-env-"));
  base = {
    APP_ENV: "test",
    DATABASE_URL_FILE: file("postgresql://public:public@localhost/lyx_test_public"),
    REDIS_URL_FILE: file("redis://localhost:6379"),
  };
  configured = {
    ...base,
    ASR_TENCENT_FILE: file(JSON.stringify(asr)),
    LLM_DOMESTIC_FILE: file(JSON.stringify(llm)),
  };
  fifo = join(directory, "public-fifo");
  execFileSync("mkfifo", [fifo]);
});
beforeEach(() => {
  vi.mocked(fs.openSync).mockClear();
  vi.mocked(fs.readSync).mockClear();
  vi.mocked(fs.closeSync).mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("配置解析不应联网"))),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fs.openSync).mockReset();
  vi.mocked(fs.readSync).mockReset();
  vi.mocked(fs.closeSync).mockReset();
  vi.unstubAllGlobals();
});
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

describe.each(APP_ENVS)("模型FILE在%s环境", (APP_ENV) => {
  it("未配时不出现模型字段，不启用驱动或预算", () => {
    const env = loadEnv({ ...base, APP_ENV });
    expect(env.ASR_TENCENT).toBeUndefined();
    expect(env.LLM_DOMESTIC).toBeUndefined();
    expect(Object.keys(env)).toEqual(["APP_ENV", "LOG_LEVEL", "DATABASE_URL", "REDIS_URL"]);
  });
  it.each(["asr", "llm", "both"])("%s配置独立可选且成型", (selection) => {
    const env = loadEnv({
      ...base,
      APP_ENV,
      ...(selection !== "llm" ? { ASR_TENCENT_FILE: configured.ASR_TENCENT_FILE } : {}),
      ...(selection !== "asr" ? { LLM_DOMESTIC_FILE: configured.LLM_DOMESTIC_FILE } : {}),
    });
    expect(env.ASR_TENCENT).toEqual(selection !== "llm" ? asr : undefined);
    expect(env.LLM_DOMESTIC).toEqual(selection !== "asr" ? llm : undefined);
    expect(JSON.stringify(env)).not.toContain(directory);
  });
  it.each(keys)("%s明文被拒绝，即使同时有合法FILE", (key) => {
    for (const filePresent of [false, true]) {
      const error = failure({
        ...base,
        ...(filePresent ? configured : {}),
        APP_ENV,
        [key]: "private-value-marker",
      });
      expect(error.issues.map((issue) => issue.key)).toEqual([key]);
      redacted(error);
    }
  });
});

describe("文件读取与冻结", () => {
  it.each(keys)("%s的空白FILE路径视为未配", (key) => {
    const env = loadEnv({ ...base, [`${key}_FILE`]: " \t\n" });
    expect(env.ASR_TENCENT).toBeUndefined();
    expect(env.LLM_DOMESTIC).toBeUndefined();
  });
  it("配置与四个endpoint均深冻结；解析不保留输入或FILE路径", () => {
    const env = loadEnv(configured);
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.ASR_TENCENT)).toBe(true);
    expect(Object.isFrozen(env.LLM_DOMESTIC)).toBe(true);
    for (const [role, priority] of routes) {
      expect(Object.isFrozen(env.LLM_DOMESTIC![role])).toBe(true);
      expect(Object.isFrozen(env.LLM_DOMESTIC![role][priority])).toBe(true);
    }
    expect(() => Reflect.set(env.ASR_TENCENT!, "secretKey", "replacement")).not.toThrow();
    expect(Reflect.set(env.ASR_TENCENT!, "secretKey", "replacement")).toBe(false);
    expect(Reflect.set(env.LLM_DOMESTIC!.vision.primary, "model", "replacement")).toBe(false);
    expect(env.ASR_TENCENT).toEqual(asr);
    expect(env.LLM_DOMESTIC).toEqual(llm);
    expect(JSON.stringify(env)).not.toContain(directory);
    fs.writeFileSync(configured.ASR_TENCENT_FILE!, JSON.stringify({ ...asr, secretKey: "next" }));
    expect(env.ASR_TENCENT).toEqual(asr);
    fs.writeFileSync(configured.ASR_TENCENT_FILE!, JSON.stringify(asr));
  });
  it.each(keys)("%s按真实字节接受4096并拒绝4097", (key) => {
    const value = key === "ASR_TENCENT" ? { ...asr, secretKey: "界".repeat(256) } : llm;
    const json = JSON.stringify(value);
    const exact = json + " ".repeat(4096 - Buffer.byteLength(json));
    expect(Buffer.byteLength(exact)).toBe(4096);
    expect(loadEnv({ ...base, [`${key}_FILE`]: file(exact) })[key]).toEqual(value);
    const error = failure({ ...base, [`${key}_FILE`]: file(exact + " ") });
    expect(error.issues.map((issue) => issue.key)).toEqual([`${key}_FILE`]);
    redacted(error);
  });
  it.each(keys)("%s的读取失败均受控且关闭实际打开的描述符", (key) => {
    for (const path of [
      join(directory, "private-file-marker-missing"),
      directory,
      fifo,
      file(" \n"),
      file("private-file-marker{"),
    ]) {
      const error = failure({ ...base, [`${key}_FILE`]: path });
      expect(error.issues.map((issue) => issue.key)).toEqual([`${key}_FILE`]);
      redacted(error);
    }
    const opened = vi.mocked(fs.openSync).mock.results.filter((result) => result.type === "return");
    const closed = vi.mocked(fs.closeSync).mock.calls.map(([fd]) => fd);
    expect(closed).toHaveLength(opened.length);
    expect(closed).toEqual(opened.map((result) => result.value));
  });
  it("模型文件read抛错仍finally关闭，静态诊断不透传异常", () => {
    // 连接串走原readFileSync；此处只注入模型普通文件的真实readSync。
    vi.mocked(fs.readSync).mockImplementationOnce(() => {
      throw new Error("private-value-marker");
    });
    const error = failure({ ...base, ASR_TENCENT_FILE: configured.ASR_TENCENT_FILE });
    expect(error.issues.map((issue) => issue.key)).toEqual(["ASR_TENCENT_FILE"]);
    expect(fs.closeSync).toHaveBeenCalledTimes(1);
    redacted(error);
  });
  it("close抛错按静态原因拒绝启动，不吞配置关闭失败", () => {
    const original = vi.mocked(fs.closeSync).getMockImplementation()!;
    vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
      original(fd);
      throw new Error("private-value-marker");
    });
    const error = failure({ ...base, ASR_TENCENT_FILE: configured.ASR_TENCENT_FILE });
    expect(error.issues).toEqual([{ key: "ASR_TENCENT_FILE", reason: "配置文件关闭失败" }]);
    redacted(error);
  });
  it("两个非法文件汇总后按ENV_KEYS稳定排序，不暴露任何原始值", () => {
    const error = failure({
      ...base,
      ASR_TENCENT_FILE: file('{"private-value-marker":true}'),
      LLM_DOMESTIC_FILE: file('{"private-value-marker":true}'),
    });
    expect(error.issues.map((issue) => issue.key)).toEqual([
      "ASR_TENCENT_FILE",
      "LLM_DOMESTIC_FILE",
    ]);
    redacted(error);
  });
});

describe("ASR完整结构与原驱动谓词", () => {
  it.each([
    null,
    [],
    "private-value-marker",
    {},
    { secretId: asr.secretId },
    { secretKey: asr.secretKey },
    { ...asr, url: "https://private-value-marker.invalid" },
    { ...asr, secretId: 123 },
    { ...asr, secretKey: 123 },
    { ...asr, secretId: "" },
    { ...asr, secretId: "a".repeat(129) },
    { ...asr, secretId: "bad space" },
    { ...asr, secretKey: "" },
    { ...asr, secretKey: "x".repeat(257) },
    { ...asr, secretKey: "😀".repeat(129) },
  ])("非法结构或字符串 %j 被拒绝", (value) => {
    const error = failure(source("ASR_TENCENT", value));
    expect(error.issues).toEqual([
      { key: "ASR_TENCENT_FILE", reason: "须为完整合法的模型JSON配置" },
    ]);
    redacted(error);
  });
  it.each([
    { secretId: "a", secretKey: "x" },
    { secretId: "a".repeat(128), secretKey: "x".repeat(256) },
    { ...asr, secretKey: "😀".repeat(128) },
    { ...asr, secretKey: " \n\u0000" },
    { ...asr, secretId: "original-id\n" },
  ])("保持已接受驱动的字符串边界 %j", (value) => {
    expect(loadEnv(source("ASR_TENCENT", value)).ASR_TENCENT).toEqual(value);
  });
});

describe("LLM完整四端点与原驱动谓词", () => {
  it.each([
    null,
    [],
    "private-value-marker",
    {},
    { text: llm.text },
    { vision: llm.vision },
    { ...llm, text: { primary: endpoint } },
    { ...llm, vision: { backup: endpoint } },
    { ...llm, text: { ...llm.text, extra: true } },
    { ...llm, baseUrl: "https://private-value-marker.invalid" },
    { ...llm, timeoutMs: 99999 },
  ])("不完整或额外配置 %j 被拒绝", (value) => {
    const error = failure(source("LLM_DOMESTIC", value));
    expect(error.issues.map((issue) => issue.key)).toEqual(["LLM_DOMESTIC_FILE"]);
    redacted(error);
  });
  it.each(routes)("%s / %s均执行严格端点校验", (role, priority) => {
    const invalid = [
      null,
      {},
      { ...endpoint, vendor: "foreign" },
      { ...endpoint, model: 1 },
      { ...endpoint, model: "" },
      { ...endpoint, model: "x".repeat(129) },
      { ...endpoint, model: "has space" },
      { ...endpoint, apiKey: 1 },
      { ...endpoint, apiKey: "" },
      { ...endpoint, apiKey: "k".repeat(513) },
      { ...endpoint, apiKey: "has space" },
      { ...endpoint, apiKey: "私有" },
      { ...endpoint, url: "https://private-value-marker.invalid" },
      { ...endpoint, workspaceId: "unexpected" },
      { ...endpoint, vendor: "deepseek", workspaceId: "unexpected" },
      { ...endpoint, vendor: "bailian" },
      { ...endpoint, vendor: "bailian", workspaceId: 123 },
      { ...endpoint, vendor: "bailian", workspaceId: "" },
      { ...endpoint, vendor: "bailian", workspaceId: "-starts-with-dash" },
      { ...endpoint, vendor: "bailian", workspaceId: "x".repeat(64) },
      { ...endpoint, vendor: "bailian", workspaceId: "has space" },
    ];
    for (const value of invalid) {
      const input = structuredClone(llm);
      Reflect.set(input[role], priority, value);
      const error = failure(source("LLM_DOMESTIC", input));
      expect(error.issues.map((issue) => issue.key)).toEqual(["LLM_DOMESTIC_FILE"]);
      redacted(error);
    }
  });
  it.each(routes)("%s / %s保持原vendor、长度和正则边界", (role, priority) => {
    for (const value of [
      { ...endpoint, model: "x".repeat(128), apiKey: "k".repeat(512) },
      { ...endpoint, vendor: "deepseek" },
      { ...endpoint, vendor: "bailian", workspaceId: "x" },
      { ...endpoint, vendor: "bailian", workspaceId: "x".repeat(63) },
      { ...endpoint, model: "original-model\n", apiKey: "original-key\n" },
      { ...endpoint, vendor: "bailian", workspaceId: "original-workspace\n" },
    ]) {
      const input = structuredClone(llm);
      Reflect.set(input[role], priority, value);
      expect(loadEnv(source("LLM_DOMESTIC", input)).LLM_DOMESTIC).toEqual(input);
    }
  });
});
