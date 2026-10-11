import { describe, expect, it } from "vitest";
import { asrCallbackUrl, prepareAsrCallback } from "./callback.js";

const key = "0123456789abcdef0123456789abcdef";
const mediaJobId = "01960000-0000-7000-8000-000000000001";
const origin = "https://callbacks.example.com";
const expected = `${origin}/api/v1/hooks/asr/media-jobs/${mediaJobId}?sig=Te8AxwzKLiZJsOeVld_9zXls7UG5pdDRXsXTPf-vPuA`;
const config = () => prepareAsrCallback({ origin, key });

describe("ASR 固定回调 URL 纯协议", () => {
  it("无配置与无上下文明确省略，不制造默认回调", () => {
    expect(prepareAsrCallback(undefined)).toBeUndefined();
    expect(asrCallbackUrl(undefined, undefined)).toBeUndefined();
  });

  it.each([origin, `${origin}/`, `${origin}:443`, `${origin}:443/`])(
    "允许HTTPS DNS origin并规范根与443：%s",
    (value) => {
      const prepared = prepareAsrCallback({ origin: value, key });
      expect(prepared).toEqual({ origin, key });
      expect(asrCallbackUrl(prepared, { mediaJobId })).toBe(expected);
    },
  );

  it("复制并冻结构造配置，不在后续调用中读取原对象", () => {
    const input = { origin, key };
    const prepared = prepareAsrCallback(input);
    input.origin = "https://another.example.com";
    input.key = "b".repeat(32);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(asrCallbackUrl(prepared, { mediaJobId })).toBe(expected);
    expect(prepared).not.toBe(input);
  });

  it.each([
    ["ASCII32", key, "Te8AxwzKLiZJsOeVld_9zXls7UG5pdDRXsXTPf-vPuA"],
    ["UTF8字节32", "密钥".repeat(5) + "ab", "iHmOyPHgrqjLcZ0rPuI-ZV219wBXB8TyMSA4b-9Phus"],
    ["UTF8字节256", "密钥".repeat(42) + "abcd", "COF2oc-AL5Ec4o4mP2z1hMaxYrWLcPK6Qli23XRMkog"],
  ])("独立公开HMAC向量 %s 保留原UTF8字节", (_name, secret, signature) => {
    const url = new URL(
      asrCallbackUrl(prepareAsrCallback({ origin, key: secret }), { mediaJobId })!,
    );
    expect(url.pathname).toBe(`/api/v1/hooks/asr/media-jobs/${mediaJobId}`);
    expect([...url.searchParams]).toEqual([["sig", signature]]);
    expect(url.hash).toBe("");
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    expect(signature).toHaveLength(43);
    expect(signature).not.toContain("=");
  });

  it.each([" ".repeat(32), "é".repeat(16), "e\u0301".repeat(11), "a".repeat(256)])(
    "合法key不trim或normalize：%s",
    (secret) => {
      const prepared = prepareAsrCallback({ origin, key: secret });
      expect(prepared?.key).toBe(secret);
      expect(asrCallbackUrl(prepared, { mediaJobId })).toMatch(/\?sig=[A-Za-z0-9_-]{43}$/);
    },
  );

  it.each([
    ["null", null],
    ["array", []],
    ["缺origin", { key }],
    ["缺key", { origin }],
    ["额外字段", { origin, key, path: "/hooks" }],
    ["symbol字段", { origin, key, [Symbol("公开测试")]: true }],
    ["继承字段", Object.assign(Object.create({ origin, key }), { x: 1, y: 2 })],
    ["key类型", { origin, key: 32 }],
    ["31字节", { origin, key: "a".repeat(31) }],
    ["257字节", { origin, key: "a".repeat(257) }],
    ["UTF8短key", { origin, key: "密".repeat(10) }],
    ["UTF8超key", { origin, key: "密".repeat(86) }],
  ])("构造拒绝%s且固定脱敏错误", (_name, value) => {
    expect(() => prepareAsrCallback(value)).toThrow(new TypeError("录音转写回调配置不合法"));
  });

  it.each([
    "http://callbacks.example.com",
    "HTTPS://callbacks.example.com",
    "https://Callbacks.example.com",
    "https://user:secret@callbacks.example.com",
    "https://callbacks.example.com:444",
    "https://callbacks.example.com/path",
    "https://callbacks.example.com//",
    "https://callbacks.example.com?sig=secret",
    "https://callbacks.example.com#fragment",
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
    `https://${"a".repeat(64)}.com`,
    `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
  ])("拒绝非固定安全origin %s", (value) => {
    expect(() => prepareAsrCallback({ origin: value, key })).toThrow("录音转写回调配置不合法");
  });

  it("253字节DNS上界签发仍显著低于本地2048字节上限", () => {
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(host).toHaveLength(253);
    const prepared = prepareAsrCallback({ origin: `https://${host}`, key });
    const url = asrCallbackUrl(prepared, { mediaJobId })!;
    expect(new URL(url).hostname).toBe(host);
    expect(Buffer.byteLength(url)).toBeLessThanOrEqual(374);
    expect(Buffer.byteLength(url)).toBeLessThan(2048);
  });

  it.each([
    ["仅配置", undefined],
    ["null", null],
    ["array", [mediaJobId]],
    ["空对象", {}],
    ["额外URL", { mediaJobId, url: "https://evil.example.com" }],
    ["额外TaskId", { mediaJobId, taskId: "1" }],
    ["额外symbol", { mediaJobId, [Symbol("公开测试")]: true }],
    ["继承ID", Object.assign(Object.create({ mediaJobId }), { x: 1 })],
    ["数字ID", { mediaJobId: 1 }],
    ["uppercase", { mediaJobId: "019a0000-0000-7000-8000-000000000001".toUpperCase() }],
    ["换行", { mediaJobId: `${mediaJobId}\n` }],
    ["空格", { mediaJobId: ` ${mediaJobId}` }],
    ["编码", { mediaJobId: mediaJobId.replace("-", "%2D") }],
    ["无连字符", { mediaJobId: mediaJobId.replaceAll("-", "") }],
  ])("半配或严格上下文%s不能退回默认", (_name, value) => {
    expect(asrCallbackUrl(config(), value)).toBeNull();
  });

  it("只有任务上下文不能签发任意默认来源", () => {
    expect(asrCallbackUrl(undefined, { mediaJobId })).toBeNull();
  });

  it("任务ID只读取一次，签名/path消费同一不可变原文", () => {
    let reads = 0;
    const context = {
      get mediaJobId() {
        reads += 1;
        return reads === 1 ? mediaJobId : "bad";
      },
    };
    expect(asrCallbackUrl(config(), context)).toBe(expected);
    expect(reads).toBe(1);
  });

  it.each([
    "00000000-0000-0000-0000-000000000000",
    "550e8400-e29b-41d4-a716-446655440000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
  ])("UUID沿receiver任何版本的小写原文谓词 %s", (id) => {
    expect(new URL(asrCallbackUrl(config(), { mediaJobId: id })!).pathname).toBe(
      `/api/v1/hooks/asr/media-jobs/${id}`,
    );
  });
});
