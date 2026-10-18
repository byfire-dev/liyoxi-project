import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";
import type { EnvSource } from "./env.js";

// 全部是本测试公开构造的假配置，不读真实配置文件。
const directory = mkdtempSync(join(tmpdir(), "lyx-w221-env-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const base = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/liyoxi",
  REDIS_URL: "redis://127.0.0.1:6389/0",
};
const appid = "wx_test_appid";
const secret = "public-fake-secret-marker";
const token = "public-fake-message-token";
const aes = "A".repeat(43);
function file(name: string, value: string): string {
  const path = join(directory, name);
  writeFileSync(path, value);
  return path;
}
const configured = {
  WECHAT_APPID: appid,
  WECHAT_SECRET_FILE: file("secret", secret + "\n"),
  WECHAT_MESSAGE_TOKEN_FILE: file("token", token + "\n"),
  WECHAT_MESSAGE_AES_KEY_FILE: file("aes", aes + "\n"),
};
const groupKeys = Object.keys(configured) as (keyof typeof configured)[];
function failure(extra: EnvSource): EnvError {
  try {
    loadEnv({ ...base, ...extra });
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error("微信配置应被拒绝");
}

describe("W221 微信完整组与FILE配置", () => {
  it("全无配置仍为空能力，空白同无", () => {
    expect(loadEnv(base).WECHAT).toBeUndefined();
    expect(loadEnv({ ...base, WECHAT_APPID: " ", WECHAT_SECRET_FILE: " " }).WECHAT).toBeUndefined();
  });
  it.each(["local", "test", "stg", "prod"])("%s完整FILE组产生冻结配置，没有FILE路径", (APP_ENV) => {
    const env = loadEnv({
      APP_ENV,
      DATABASE_URL_FILE: file(`${APP_ENV}-database`, base.DATABASE_URL),
      REDIS_URL_FILE: file(`${APP_ENV}-redis`, base.REDIS_URL),
      ...configured,
    });
    expect(env.WECHAT).toEqual({ appid, secret, messageToken: token, messageEncodingAESKey: aes });
    expect(Object.isFrozen(env.WECHAT)).toBe(true);
    expect(JSON.stringify(env.WECHAT)).not.toContain(directory);
  });
  it.each(Array.from({ length: 14 }, (_, index) => index + 1))(
    "非空但不完整子集 %i 启动失败",
    (bits) => {
      const partial: Record<string, string> = {};
      const missing: string[] = [];
      groupKeys.forEach((key, index) => {
        if (bits & (1 << index)) partial[key] = configured[key];
        else missing.push(key);
      });
      const error = failure(partial);
      for (const key of missing) expect(error.issues.some((issue) => issue.key === key)).toBe(true);
      expect(error.message).not.toContain(directory);
      expect(error.message).not.toContain(secret);
    },
  );
  it("custom groups不能绕过微信半配", () => {
    expect(() => loadEnv({ ...base, WECHAT_APPID: appid }, { groups: [] })).toThrow(EnvError);
  });
  it.each(["WECHAT_SECRET", "WECHAT_MESSAGE_TOKEN", "WECHAT_MESSAGE_AES_KEY"])(
    "任何环境拒绝敏感明文键 %s",
    (key) => {
      for (const APP_ENV of ["local", "test", "stg", "prod"]) {
        const error = failure({
          ...configured,
          APP_ENV,
          DATABASE_URL: undefined,
          REDIS_URL: undefined,
          DATABASE_URL_FILE: file("plain-db", base.DATABASE_URL),
          REDIS_URL_FILE: file("plain-redis", base.REDIS_URL),
          [key]: "plaintext-private-marker",
        });
        expect(error.issues.some((issue) => issue.key === key)).toBe(true);
        expect(error.message).not.toContain("plaintext-private-marker");
      }
    },
  );
  it.each(["WECHAT_SECRET_FILE", "WECHAT_MESSAGE_TOKEN_FILE", "WECHAT_MESSAGE_AES_KEY_FILE"])(
    "%s读失败/空白/超大都受控，错误无路径/内容",
    (key) => {
      for (const path of [
        join(directory, "missing-private-path"),
        file("empty", " \n"),
        file("oversized", "private-content-marker".repeat(300)),
      ]) {
        const error = failure({ ...configured, [key]: path });
        expect(error.issues.some((issue) => issue.key === key)).toBe(true);
        expect(error.message).not.toContain(directory);
        expect(error.message).not.toContain("private-content-marker");
        expect(error.message).not.toContain("ENOENT");
      }
    },
  );
  it.each([
    { WECHAT_APPID: "has space" },
    { WECHAT_APPID: "wx:bad" },
    { WECHAT_APPID: "x".repeat(129) },
    { WECHAT_SECRET_FILE: file("invalid-secret", "a\u0000b") },
    { WECHAT_SECRET_FILE: file("large-secret", "x".repeat(257)) },
    { WECHAT_MESSAGE_TOKEN_FILE: file("invalid-token", "a\nb") },
    { WECHAT_MESSAGE_TOKEN_FILE: file("large-token", "x".repeat(129)) },
    { WECHAT_MESSAGE_AES_KEY_FILE: file("short-aes", "A".repeat(42)) },
    { WECHAT_MESSAGE_AES_KEY_FILE: file("noncanonical-aes", "A".repeat(42) + "B") },
    { WECHAT_MESSAGE_AES_KEY_FILE: file("long-aes", "A".repeat(44)) },
  ])("配置形状不合格拒绝且错误脱敏 %#", (override) => {
    const error = failure({ ...configured, ...override });
    expect(error.message).not.toContain(directory);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(token);
  });
  it("可见ASCII恰边界与规范32-byte AES接受", () => {
    const env = loadEnv({
      ...base,
      WECHAT_APPID: "x".repeat(128),
      WECHAT_SECRET_FILE: file("secret-boundary", "x".repeat(256)),
      WECHAT_MESSAGE_TOKEN_FILE: file("token-boundary", "x".repeat(128)),
      WECHAT_MESSAGE_AES_KEY_FILE: configured.WECHAT_MESSAGE_AES_KEY_FILE,
    });
    expect(env.WECHAT?.secret).toHaveLength(256);
    expect(env.WECHAT?.messageToken).toHaveLength(128);
  });
});
