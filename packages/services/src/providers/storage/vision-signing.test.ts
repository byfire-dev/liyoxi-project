import { createHash, createHmac } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStorage } from "../../testing/providers/storage.js";
import { unconfiguredStorage } from "../unconfigured.js";
import { withBeforeCall } from "../types.js";
import type { ProviderResult, VisionReadInput } from "../types.js";
import { createCosStorage } from "./cos.js";
import type { CosConfig } from "./cos.js";
import { createMinioStorage } from "./minio.js";

const NOW = new Date("2026-01-05T04:00:00.000Z");
const keys = { secretId: "publicfakeid", secretKey: "publicfakekey" };
const config: CosConfig = {
  region: "ap-beijing",
  buckets: {
    secure: "test-secure-1250000000",
    asset: "test-asset-1250000000",
    media: "test-media-1250000000",
    pub: "test-pub-1250000000",
  },
  signer: keys,
};
const input: VisionReadInput = {
  bucket: "asset",
  key: "files/公开 image+?.png",
  expiresSec: 900,
  source: { kind: "image" },
};
const IMAGE = "imageMogr2/auto-orient|imageMogr2/thumbnail/1280x1280>|imageMogr2/format/jpg";
const RESIZE = "imageMogr2/thumbnail/1280x1280>";
const VIDEO = {
  "ci-process": "snapshot",
  time: "1.500",
  width: "0",
  height: "0",
  format: "jpg",
  rotate: "auto",
  mode: "exactframe",
  [RESIZE]: "",
};
const drivers: Array<{ close(): Promise<void> }> = [];
const network = vi.fn<typeof fetch>(async () => {
  throw new Error("Signing must not issue HTTP");
});
function driver(region = config.region, now = () => NOW, workerOnly = false) {
  const value = createCosStorage(
    {
      ...config,
      region,
      ...(workerOnly ? { signer: undefined, worker: keys } : {}),
    },
    { now, fetchImpl: network },
  );
  drivers.push(value);
  return value;
}
function unwrap<T>(result: ProviderResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected a local signature");
  return result.value;
}
function processing(url: URL) {
  return Object.fromEntries([...url.searchParams].filter(([key]) => !key.startsWith("q-")));
}

// Independent byte encoder and COS v5 HMAC oracle; no production signer/helper imports.
function encode(value: string) {
  return [...Buffer.from(value)]
    .map((byte) =>
      (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) ||
      (byte >= 48 && byte <= 57) ||
      [45, 46, 95, 126].includes(byte)
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .join("");
}
function canonical(query: Record<string, string>) {
  return Object.entries(query)
    .map(([key, value]) => [encode(key).toLowerCase(), encode(value)])
    .sort(([left], [right]) => (left! < right! ? -1 : left! > right! ? 1 : 0));
}
function signature(url: URL, method = "get") {
  const time = url.searchParams.get("q-sign-time")!;
  const query = canonical(processing(url))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const text = `${method}\n${decodeURIComponent(url.pathname)}\n${query}\nhost=${encode(url.host)}\n`;
  const digest = createHash("sha1").update(text).digest("hex");
  const signKey = createHmac("sha1", keys.secretKey).update(time).digest("hex");
  return createHmac("sha1", signKey).update(`sha1\n${time}\n${digest}\n`).digest("hex");
}
function verify(url: URL) {
  expect(url.searchParams.get("q-sign-algorithm")).toBe("sha1");
  expect(url.searchParams.get("q-ak")).toBe(keys.secretId);
  expect(url.searchParams.get("q-key-time")).toBe(url.searchParams.get("q-sign-time"));
  expect(url.searchParams.get("q-header-list")).toBe("host");
  expect(url.searchParams.get("q-url-param-list")).toBe(
    canonical(processing(url))
      .map(([key]) => key)
      .join(";"),
  );
  expect(url.searchParams.get("q-signature")).toBe(signature(url));
}
afterEach(async () => {
  for (const value of drivers.splice(0)) await value.close();
  expect(network).not.toHaveBeenCalled();
  network.mockClear();
  vi.restoreAllMocks();
});

describe("固定视觉 GET 的独立签名协议（无真实 COS 请求）", () => {
  it("图片按 auto-orient→1280 上界→jpg 顺序，整个空值处理键参与签名", async () => {
    const result = unwrap(await driver().presignVisionGet(input));
    const url = new URL(result.url);
    expect(processing(url)).toEqual({ [IMAGE]: "" });
    expect(url.host).toBe("test-asset-1250000000.cos.ap-beijing.myqcloud.com");
    expect(decodeURIComponent(url.pathname)).toBe(`/${input.key}`);
    expect(url.searchParams.get("q-sign-time")).toBe("1767585600;1767586500");
    // Independently generated with Python stdlib HMAC/urllib, not cosAuthorization.
    expect(url.searchParams.get("q-signature")).toBe("b9b31e0ea39230a0a6c54b3ff8d9570387184b55");
    expect(result.expiresAt.toISOString()).toBe("2026-01-05T04:15:00.000Z");
    expect([...url.searchParams]).toHaveLength(8);
    verify(url);
  });

  it("视频八参数全部签名，0/0 保持比例后应用固定缩小处理", async () => {
    const result = unwrap(
      await driver().presignVisionGet({ ...input, source: { kind: "video-frame", atMs: 1500 } }),
    );
    const url = new URL(result.url);
    expect(processing(url)).toEqual(VIDEO);
    expect([...url.searchParams]).toHaveLength(15);
    expect(url.searchParams.get("q-signature")).toBe("969b366f7f8318c39bbe624910e96f3cfbdb3981");
    verify(url);
  });

  it.each(Object.keys(VIDEO))("视频参数 %s 修改或删除都会失去原签名", async (field) => {
    const result = unwrap(
      await driver().presignVisionGet({ ...input, source: { kind: "video-frame", atMs: 1500 } }),
    );
    const url = new URL(result.url);
    const original = url.searchParams.get("q-signature");
    url.searchParams.set(field, `${url.searchParams.get(field)}tampered`);
    expect(signature(url)).not.toBe(original);
    url.searchParams.delete(field);
    expect(signature(url)).not.toBe(original);
  });

  it("图片处理键不能删除、改序、插入原图降级或改变输出格式", async () => {
    const url = new URL(unwrap(await driver().presignVisionGet(input)).url);
    const original = url.searchParams.get("q-signature");
    for (const key of [
      "imageMogr2/format/jpg|imageMogr2/thumbnail/1280x1280>",
      `${IMAGE}/ignore-error/1`,
      IMAGE.replace("jpg", "png"),
    ]) {
      const changed = new URL(url);
      changed.searchParams.delete(IMAGE);
      changed.searchParams.set(key, "");
      expect(signature(changed)).not.toBe(original);
    }
    url.searchParams.delete(IMAGE);
    expect(signature(url)).not.toBe(original);
  });

  it("签名绑定 GET、固定 host、原对象键、处理键空值和期限", async () => {
    const url = new URL(unwrap(await driver().presignVisionGet(input)).url);
    const original = url.searchParams.get("q-signature");
    expect(signature(url, "post")).not.toBe(original);
    const mutations: Array<(value: URL) => void> = [
      (value) => {
        value.hostname = "other.invalid";
      },
      (value) => {
        value.pathname += "other";
      },
      (value) => {
        value.searchParams.set(IMAGE, "1");
      },
      (value) => {
        value.searchParams.set("q-sign-time", "1767585600;1767586501");
      },
      (value) => {
        value.searchParams.set("download", "1");
      },
    ];
    for (const mutate of mutations) {
      const changed = new URL(url);
      mutate(changed);
      expect(signature(changed)).not.toBe(original);
    }
  });

  it.each([
    [0, "0.000"],
    [1, "0.001"],
    [999, "0.999"],
    [1000, "1.000"],
    [1500, "1.500"],
    [60001, "60.001"],
    [Number.MAX_SAFE_INTEGER, "9007199254740.991"],
  ] as const)("%i 毫秒只用整数商余转换为 %s 秒", async (atMs, seconds) => {
    const url = new URL(
      unwrap(await driver().presignVisionGet({ ...input, source: { kind: "video-frame", atMs } }))
        .url,
    );
    expect(url.searchParams.get("time")).toBe(seconds);
    verify(url);
  });

  it.each([
    "files/中文/🍜.png",
    "files/a b+c%2F?#&='!()*.png",
    "files/é/图像.jpg",
    `files/${"界".repeat(339)}x`,
  ])("Unicode/特殊对象键 %s 完整编码且独立 HMAC 相同", async (key) => {
    const url = new URL(unwrap(await driver().presignVisionGet({ ...input, key })).url);
    expect(decodeURIComponent(url.pathname)).toBe(`/${key}`);
    expect(url.hash).toBe("");
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    verify(url);
  });

  it.each(["secure", "asset", "media", "pub"] as const)("只签配置里的 %s 桶", async (bucket) => {
    const url = new URL(unwrap(await driver().presignVisionGet({ ...input, bucket })).url);
    expect(url.host).toBe(`${config.buckets[bucket]}.cos.ap-beijing.myqcloud.com`);
    verify(url);
  });

  it.each([
    "ap-beijing",
    "ap-shanghai",
    "ap-guangzhou",
    "ap-chengdu",
    "ap-chongqing",
    "ap-nanjing",
  ])("国内允许地域 %s 使用固定 COS host", async (region) => {
    const url = new URL(unwrap(await driver(region).presignVisionGet(input)).url);
    expect(url.hostname).toBe(`${config.buckets.asset}.cos.${region}.myqcloud.com`);
    verify(url);
  });

  it.each(["ap-hongkong", "ap-singapore", "na-siliconvalley", "eu-frankfurt"])(
    "不支持的新视觉地域 %s 不影响旧 presignGet",
    async (region) => {
      const storage = driver(region);
      expect(await storage.presignVisionGet(input)).toMatchObject({
        ok: false,
        reason: "unsupported",
      });
      const url = new URL(unwrap(await storage.presignGet(input)).url);
      expect(processing(url)).toEqual({});
      expect(url.hostname).toBe(`${config.buckets.asset}.cos.${region}.myqcloud.com`);
      verify(url);
    },
  );
});

describe("严格输入、期限与关闭", () => {
  const badInputs: unknown[] = [
    null,
    undefined,
    [],
    "url",
    {},
    { ...input, source: undefined },
    { ...input, source: null },
    { ...input, source: [] },
    { ...input, source: { kind: "image", atMs: 0 } },
    { ...input, source: { kind: "image", query: {} } },
    { ...input, source: { kind: "video-frame" } },
    { ...input, source: { kind: "video-frame", atMs: 0, mode: "keyframe" } },
    { ...input, source: { kind: "snapshot", atMs: 0 } },
    { ...input, url: "https://other.invalid/private" },
    { ...input, query: { "ignore-error": "1" } },
    { ...input, downloadName: "private-name" },
    { ...input, disposition: "inline" },
    { ...input, bucket: "other" },
    { ...input, key: 42 },
    { ...input, key: "" },
    { ...input, key: "files/../private" },
    { ...input, key: "./private" },
    { ...input, key: "files\\private" },
    { ...input, key: "files/\nprivate" },
    { ...input, key: "files/\u0000private" },
    { ...input, key: "files/\ud800private" },
    { ...input, key: "界".repeat(342) },
  ];
  it.each(badInputs.map((value, index) => ({ value, index })))(
    "非法形状 $index 安全拒绝且不传播入参",
    async ({ value }) => {
      const result = await driver().presignVisionGet(value as VisionReadInput);
      expect(result).toEqual({ ok: false, reason: "rejected", message: "COS 请求参数不合格" });
    },
  );

  it.each([-1, 0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null])(
    "非法毫秒 %s 不舍入、不签名",
    async (atMs) => {
      expect(
        await driver().presignVisionGet({
          ...input,
          source: { kind: "video-frame", atMs },
        } as VisionReadInput),
      ).toMatchObject({ ok: false, reason: "rejected" });
    },
  );

  it.each([0, -1, 3601, 1.5, Infinity, NaN, "900", null, undefined])(
    "非法到期秒数 %s 不签名",
    async (expiresSec) => {
      expect(
        await driver().presignVisionGet({ ...input, expiresSec } as VisionReadInput),
      ).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    },
  );

  it.each([1, 3600])("合法期限 %i 秒按时钟整秒计算", async (expiresSec) => {
    const now = () => new Date(NOW.getTime() + 999);
    const result = unwrap(
      await driver(config.region, now).presignVisionGet({ ...input, expiresSec }),
    );
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + expiresSec * 1000);
    const url = new URL(result.url);
    expect(url.searchParams.get("q-sign-time")).toBe(`1767585600;${1767585600 + expiresSec}`);
    verify(url);
  });

  it.each([new Date(NaN), new Date(-1), new Date(8640000000000000)])(
    "时钟无法表达有效的有限到期时间 %s 时拒绝",
    async (at) => {
      expect(await driver(config.region, () => at).presignVisionGet(input)).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    },
  );

  it("worker-only 使用既有 readKey，调用者输入被快照且到期时间独立", async () => {
    let current = NOW.getTime();
    const storage = driver(config.region, () => new Date(current), true);
    const request: VisionReadInput = { ...input, source: { kind: "video-frame", atMs: 1500 } };
    const pending = storage.presignVisionGet(request);
    request.key = "files/changed";
    const first = unwrap(await pending);
    expect(decodeURIComponent(new URL(first.url).pathname)).toBe(`/${input.key}`);
    current += 1000;
    const second = unwrap(await storage.presignVisionGet(input));
    expect(second.expiresAt.getTime()).toBe(first.expiresAt.getTime() + 1000);
    expect(second.url).not.toBe(first.url);
    first.expiresAt.setTime(0);
    expect(second.expiresAt.getTime()).toBe(current + 900000);
    verify(new URL(second.url));
  });

  it("close 可重复且不留下自有 timer，不再签发新地址", async () => {
    vi.useFakeTimers();
    try {
      const storage = driver();
      unwrap(await storage.presignVisionGet(input));
      await storage.close();
      await storage.close();
      expect(await storage.presignVisionGet(input)).toMatchObject({
        ok: false,
        reason: "rejected",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("原 beforeCall 公口仍接收新方法且阻断先于签发", async () => {
    const before = vi.fn(() => {
      throw new Error("transaction guard");
    });
    const storage = withBeforeCall("storage", driver(), before);
    await expect(storage.presignVisionGet(input)).rejects.toThrow("transaction guard");
    expect(before).toHaveBeenCalledExactlyOnceWith({
      provider: "storage",
      method: "presignVisionGet",
    });
  });
});

describe("旧 GET 与默认实现兼容", () => {
  it("旧 presignGet 固定向量、无处理参数、同一对象保持原输出", async () => {
    const result = unwrap(await driver().presignGet(input));
    const url = new URL(result.url);
    expect(processing(url)).toEqual({});
    expect(url.searchParams.get("q-signature")).toBe("aae29b92c7bd53328647b67aee845e4e699d68f4");
    expect(result.expiresAt.toISOString()).toBe("2026-01-05T04:15:00.000Z");
    verify(url);
  });

  it("旧下载文件名/disposition 保留且没有视觉处理", async () => {
    const result = unwrap(
      await driver().presignGet({ ...input, downloadName: "公开 下载.pdf", disposition: "inline" }),
    );
    const url = new URL(result.url);
    expect(processing(url)).toEqual({
      "response-content-disposition":
        "inline; filename*=UTF-8''%E5%85%AC%E5%BC%80%20%E4%B8%8B%E8%BD%BD.pdf",
    });
    verify(url);
  });

  it("MinIO 显式不支持，构造与调用不接触网络或创建桶", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    const storage = createMinioStorage();
    drivers.push(storage);
    const ensure = vi.spyOn(storage, "ensureBuckets");
    expect(await storage.presignVisionGet(input)).toEqual({
      ok: false,
      reason: "unsupported",
      message: "本地 MinIO 不提供 CI 视觉处理签名",
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(storage.status).toBe("local");
  });

  it("未配置仍返回原 storageOff 语义，无默认启用", async () => {
    expect(unconfiguredStorage.configured).toBe(false);
    expect(unconfiguredStorage.status).toBe("unconfigured");
    const ordinary = await unconfiguredStorage.presignGet(input);
    expect(await unconfiguredStorage.presignVisionGet(input)).toEqual(ordinary);
    expect(ordinary).toMatchObject({ ok: false, reason: "unconfigured" });
  });

  it("替身默认 unsupported，不伪造产物，保留记录/失败/可拨延迟", async () => {
    let at = NOW.getTime();
    const storage = createFakeStorage({ clock: { now: () => new Date(at) } });
    storage.put(input, new Uint8Array([1, 2]), "image/png");
    const original = new Map(storage.objects);
    expect(await storage.presignVisionGet(input)).toMatchObject({
      ok: false,
      reason: "unsupported",
    });
    expect(storage.callsOf("presignVisionGet")).toEqual([
      { method: "presignVisionGet", input, at: NOW },
    ]);
    storage.failNext("presignVisionGet");
    expect(await storage.presignVisionGet(input)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    storage.delayNext("presignVisionGet", 10);
    const pending = storage.presignVisionGet(input);
    expect(storage.pendingCalls()).toBe(1);
    at += 9;
    expect(storage.tick()).toBe(0);
    at += 1;
    expect(storage.tick()).toBe(1);
    expect(await pending).toMatchObject({ ok: false, reason: "unsupported" });
    expect(storage.pendingCalls()).toBe(0);
    expect(storage.objects).toEqual(original);
    expect(storage.callsOf("presignVisionGet")).toHaveLength(3);
    const ordinary = unwrap(await storage.presignGet(input));
    expect(storage.fetch(ordinary.url)).toMatchObject({
      status: 200,
      body: new Uint8Array([1, 2]),
    });
  });
});
