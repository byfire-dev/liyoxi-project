import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as proxyRequest } from "node:http";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { INCOMING_PREFIX, STORAGE_BUCKETS } from "../types.js";
import type { ObjectRef, PresignedPost, StorageBucket } from "../types.js";
import { createMinioStorage, LOCAL_MINIO } from "./minio.js";

// 本地 MinIO 驱动的用例（W0-19 任务书 第 7 节第 6 条）。连的是 infra/compose/local.yml 那套共享容器：
// 先跑 pnpm infra:up。
// MinIO 连不上时：
//   给了 LYX_TEST_MINIO=required   整个文件失败。CI 的“MinIO 驱动的用例”一步带着它，验收也带着它跑
//   没给                           要连 MinIO 的几组跳过并提示，其余照跑。每晚的 Node 26 任务没有任何本地依赖，
//                                  pnpm test 走的是这一条
// 那套容器由几个会话共用：每次运行用自己的键前缀，用完只删自己建的对象，不删桶。

const runId = `w019-${randomUUID()}`;
const storage = createMinioStorage();
const created: ObjectRef[] = [];
const MIME = "application/octet-stream";

/** 照预签名表单直传：字段原样放进表单，文件放最后 */
async function upload(post: PresignedPost, body: Uint8Array<ArrayBuffer>): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(post.fields)) form.set(name, value);
  form.set("file", new Blob([body]));
  return fetch(post.url, { method: "POST", body: form });
}

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

/** 直传一个对象到写入区，返回它的引用 */
async function put(bucket: StorageBucket, name: string, body: Uint8Array<ArrayBuffer>) {
  const key = `${INCOMING_PREFIX}${runId}/${name}`;
  const post = await storage.presignPost({
    bucket,
    key,
    mime: MIME,
    maxBytes: 1024,
    expiresSec: 60,
  });
  if (!post.ok) throw new Error(`签发直传表单没成：${post.message}`);
  const response = await upload(post.value, body);
  created.push({ bucket, key });
  return { key, post: post.value, response };
}

const prepared = await storage.ensureBuckets();
if (!prepared.ok) {
  if (process.env.LYX_TEST_MINIO === "required") {
    throw new Error(`本地 MinIO 用不了：${prepared.message}`);
  }
  // 直接写标准错误：Vitest 不显示通过的用例文件里 console 的输出
  process.stderr.write(`[minio.test] 要连本地 MinIO 的用例跳过：${prepared.message}\n`);
}
/** 要连 MinIO 的用例组 */
const live = prepared.ok ? describe : describe.skip;

afterAll(async () => {
  for (const ref of created) await storage.delete(ref);
  storage.close();
});

describe("连接参数", () => {
  it("LOCAL_MINIO 与 infra/compose/local.yml 一致；桶名照任务书 第 11 节第 4 项", () => {
    const compose = readFileSync(
      fileURLToPath(new URL("../../../../../infra/compose/local.yml", import.meta.url)),
      "utf8",
    );
    const port = compose.match(/"127\.0\.0\.1:(\d+):9000"/)?.[1];
    expect(LOCAL_MINIO.endpoint).toBe(`http://127.0.0.1:${port}`);
    expect(LOCAL_MINIO.accessKey).toBe(compose.match(/MINIO_ROOT_USER: (\S+)/)?.[1]);
    expect(LOCAL_MINIO.secretKey).toBe(compose.match(/MINIO_ROOT_PASSWORD: (\S+)/)?.[1]);
    expect(LOCAL_MINIO.buckets).toEqual({
      secure: "lyx-local-secure",
      asset: "lyx-local-asset",
      media: "lyx-local-media",
      pub: "lyx-local-pub",
    });
  });

  it("生效状态是 local；没有临时密钥，没有版本控制", async () => {
    expect(storage.status).toBe("local");
    expect(storage.configured).toBe(true);
    expect(storage.capabilities).toEqual({ sts: false, versioning: false });
    expect(
      await storage.issueSts({ bucket: "media", keyPrefix: INCOMING_PREFIX, durationSec: 900 }),
    ).toMatchObject({ ok: false, reason: "unsupported" });
  });

  it("上传位置只暴露真实地域和物理桶名，自定义配置也不获得 STS 能力", async () => {
    expect(storage.uploadLocation).toEqual({
      region: LOCAL_MINIO.region,
      buckets: LOCAL_MINIO.buckets,
    });
    const config = {
      ...LOCAL_MINIO,
      region: "us-west-2",
      buckets: {
        secure: "fixture-secure",
        asset: "fixture-asset",
        media: "fixture-media",
        pub: "fixture-pub",
      },
    };
    const custom = createMinioStorage(config);
    try {
      expect(custom.status).toBe("local");
      expect(custom.uploadLocation).toEqual({ region: config.region, buckets: config.buckets });
      expect(Object.keys(custom.uploadLocation!)).toEqual(["region", "buckets"]);
      expect(custom.capabilities).toEqual({ sts: false, versioning: false });
      expect(
        await custom.issueSts({ bucket: "media", keyPrefix: INCOMING_PREFIX, durationSec: 900 }),
      ).toMatchObject({ ok: false, reason: "unsupported" });
    } finally {
      await custom.close();
    }
  });
});

live("初始化时建四个桶", () => {
  it("再建一次：四个桶都已经在，一个也不用新建", async () => {
    const again = createMinioStorage();
    try {
      expect(await again.ensureBuckets()).toEqual({ ok: true, value: { created: [] } });
    } finally {
      again.close();
    }
  });
});

live("五步连通，四个桶都可用", () => {
  it("外部直传与签读走保留 Host 的代理，服务端仍走内部地址", async () => {
    const proxy = createServer((incoming, outgoing) => {
      const upstream = proxyRequest(
        `${LOCAL_MINIO.endpoint}${incoming.url ?? "/"}`,
        { method: incoming.method, headers: incoming.headers },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => outgoing.destroy());
      incoming.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("代理没有监听端口");
    const publicEndpoint = `http://127.0.0.1:${address.port}`;
    const external = createMinioStorage({ ...LOCAL_MINIO, publicEndpoint });
    const ref = { bucket: "asset" as const, key: `${INCOMING_PREFIX}${runId}/external.bin` };
    const dst = { bucket: "asset" as const, key: `files/${runId}/external.bin` };
    created.push(ref, dst);
    try {
      const body = bytesOf("手机照片代理验签");
      const post = await external.presignPost({
        ...ref,
        mime: MIME,
        maxBytes: 1024,
        expiresSec: 60,
      });
      if (!post.ok) throw new Error(post.message);
      expect(new URL(post.value.url).origin).toBe(publicEndpoint);
      expect((await upload(post.value, body)).status).toBe(204);
      const head = await external.head(ref);
      if (!head.ok || !head.value.etag) throw new Error("内部地址没读到上传对象");
      expect(
        await external.copy({ src: ref, dst, ifMatchEtag: head.value.etag, contentType: MIME }),
      ).toMatchObject({
        ok: true,
      });
      const signed = await external.presignGet({ ...dst, expiresSec: 60 });
      if (!signed.ok) throw new Error(signed.message);
      expect(new URL(signed.value.url).origin).toBe(publicEndpoint);
      const read = await fetch(signed.value.url);
      expect(read.status).toBe(200);
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(body);
      // GET 的 Host 在签名中：签完再换内部 Host 必须验签失败。
      const tampered = new URL(signed.value.url);
      tampered.host = new URL(LOCAL_MINIO.endpoint).host;
      expect((await fetch(tampered)).status).toBe(403);
    } finally {
      external.close();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each(STORAGE_BUCKETS)(
    "%s 桶：表单直传到 incoming/ → 读对象头 → 条件复制到正式区 → 签发读地址 → 删除",
    async (bucket) => {
      const body = bytesOf(`狸有戏 ${bucket} ${runId}`);

      // 1. 表单直传到写入区
      const { key, response } = await put(bucket, `${bucket}.bin`, body);
      expect(key.startsWith("incoming/")).toBe(true);
      expect(response.status).toBe(204);

      // 2. 读对象头
      const head = await storage.head({ bucket, key });
      expect(head).toMatchObject({ ok: true, value: { exists: true, size: body.byteLength } });
      if (!head.ok || head.value.etag === undefined) throw new Error("没读到 etag");

      // 3. 条件复制到正式区，改写内容类型
      const dst = { bucket, key: `files/${runId}/${bucket}.txt` };
      created.push(dst);
      const copied = await storage.copy({
        src: { bucket, key },
        dst,
        ifMatchEtag: head.value.etag,
        contentType: "text/plain; charset=utf-8",
      });
      expect(copied).toMatchObject({ ok: true });
      expect(await storage.head(dst)).toMatchObject({
        ok: true,
        value: { exists: true, size: body.byteLength, mime: "text/plain; charset=utf-8" },
      });

      // 4. 签发读地址：读回来的内容与传上去的相同
      const signed = await storage.presignGet({ ...dst, expiresSec: 300 });
      if (!signed.ok) throw new Error(signed.message);
      const read = await fetch(signed.value.url);
      expect(read.status).toBe(200);
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(body);

      // 5. 删除：正式区与写入区的都删掉，读对象头回“不存在”，原来的读地址读不到
      expect(await storage.delete(dst)).toEqual({ ok: true, value: undefined });
      expect(await storage.delete({ bucket, key })).toEqual({ ok: true, value: undefined });
      expect(await storage.head(dst)).toEqual({ ok: true, value: { exists: false, size: 0 } });
      expect((await fetch(signed.value.url)).status).toBe(404);
    },
  );
});

describe("写入区", () => {
  it("键不在 incoming/ 下：不签发", async () => {
    const result = await storage.presignPost({
      bucket: "asset",
      key: `files/${runId}/direct.bin`,
      mime: MIME,
      maxBytes: 1024,
      expiresSec: 60,
    });
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
  });
});

live("直传的限制", () => {
  it("超过签发时定的大小：MinIO 拒收，对象没有落地", async () => {
    const { key, response } = await put("asset", "too-big.bin", new Uint8Array(2048));
    expect(response.status).toBe(400);
    expect(await storage.head({ bucket: "asset", key })).toEqual({
      ok: true,
      value: { exists: false, size: 0 },
    });
  });

  it("内容类型与签发时不同：MinIO 拒收", async () => {
    const key = `${INCOMING_PREFIX}${runId}/wrong-type.bin`;
    const post = await storage.presignPost({
      bucket: "asset",
      key,
      mime: MIME,
      maxBytes: 1024,
      expiresSec: 60,
    });
    if (!post.ok) throw new Error(post.message);
    created.push({ bucket: "asset", key });
    const tampered = {
      ...post.value,
      fields: { ...post.value.fields, "Content-Type": "text/html" },
    };
    expect((await upload(tampered, bytesOf("x"))).status).toBe(403);
  });
});

live("条件复制", () => {
  it("etag 对不上：不复制，返回 rejected", async () => {
    const { key } = await put("media", "stale.bin", bytesOf("第一版"));
    const dst = { bucket: "media" as const, key: `files/${runId}/stale.bin` };
    created.push(dst);
    const result = await storage.copy({
      src: { bucket: "media", key },
      dst,
      ifMatchEtag: '"00000000000000000000000000000000"',
      contentType: MIME,
    });
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    expect(await storage.head(dst)).toEqual({ ok: true, value: { exists: false, size: 0 } });
  });
});

live("完整对象有界读取", () => {
  it("真实 MinIO 的 HEAD、IfMatch 完整读取、独立字节、大小边界与 etag 变更", async () => {
    const ref = { bucket: "secure", key: `files/${runId}/bounded.pdf` } as const;
    const body = bytesOf("真实完整文档字节");
    created.push(ref);
    const written = await storage.putObject({ ...ref, body, contentType: MIME });
    if (!written.ok) throw new Error(written.message);
    const input = { ...ref, maxBytes: body.byteLength, ifMatchEtag: written.value.etag };
    const read = await storage.readObject(input);
    expect(read).toEqual({ ok: true, value: body });
    if (!read.ok) throw new Error(read.message);
    read.value[0] = 0;
    expect(await storage.readObject({ ...ref, maxBytes: body.byteLength })).toEqual({
      ok: true,
      value: body,
    });
    expect(await storage.readObject({ ...input, maxBytes: body.byteLength - 1 })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(
      await storage.putObject({ ...ref, body: bytesOf("变更后"), contentType: MIME }),
    ).toMatchObject({ ok: true });
    expect(await storage.readObject(input)).toMatchObject({ ok: false, reason: "rejected" });
    expect(await storage.readObject({ ...input, key: `${ref.key}/missing` })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
  });

  it("空对象可完整读取；旧 readPrefix 4096 上限与条件读取保持", async () => {
    const ref = { bucket: "secure", key: `files/${runId}/empty.bin` } as const;
    created.push(ref);
    expect(
      await storage.putObject({ ...ref, body: new Uint8Array(), contentType: MIME }),
    ).toMatchObject({ ok: true });
    expect(await storage.readObject({ ...ref, maxBytes: 1 })).toEqual({
      ok: true,
      value: new Uint8Array(),
    });
    const big = { ...ref, key: `files/${runId}/prefix.bin` };
    created.push(big);
    const body = new Uint8Array(4097).fill(7);
    const written = await storage.putObject({ ...big, body, contentType: MIME });
    if (!written.ok) throw new Error(written.message);
    expect(
      await storage.readPrefix({ ...big, bytes: 4096, ifMatchEtag: written.value.etag }),
    ).toEqual({ ok: true, value: body.slice(0, 4096) });
    expect(await storage.readPrefix({ ...big, bytes: 4097 })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
  });
});

live("读地址", () => {
  it("给了下载文件名：按附件下载", async () => {
    const { key } = await put("secure", "named.bin", bytesOf("授权书"));
    const signed = await storage.presignGet({
      bucket: "secure",
      key,
      expiresSec: 300,
      downloadName: "授权书.pdf",
    });
    if (!signed.ok) throw new Error(signed.message);
    const read = await fetch(signed.value.url);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("授权书.pdf")}`,
    );
  });

  it("不带签名直接读：被拒（桶是私有的）", async () => {
    const { key } = await put("pub", "private.bin", bytesOf("x"));
    const signed = await storage.presignGet({ bucket: "pub", key, expiresSec: 300 });
    if (!signed.ok) throw new Error(signed.message);
    const bare = signed.value.url.split("?")[0] ?? "";
    expect((await fetch(bare)).status).toBe(403);
  });

  it("过期后访问被拒", { timeout: 40_000 }, async () => {
    const { key } = await put("media", "expiring.bin", bytesOf("样片"));
    const signed = await storage.presignGet({ bucket: "media", key, expiresSec: 1 });
    if (!signed.ok) throw new Error(signed.message);
    // 容器与本机的时钟可能差一点：过了到期时刻之后隔半秒看一次，30 秒内必须被拒
    const deadline = Date.now() + 30_000;
    let status = 0;
    let body = "";
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (Date.now() < signed.value.expiresAt.getTime()) continue;
      const response = await fetch(signed.value.url);
      status = response.status;
      body = await response.text();
      if (status === 403) break;
    }
    expect(status).toBe(403);
    expect(body).toContain("Request has expired");
  });
});

describe("MinIO 连不上", () => {
  it("返回 unavailable，不抛错；提示里不带地址与账号", async () => {
    const unreachable = createMinioStorage({ ...LOCAL_MINIO, endpoint: "http://127.0.0.1:1" });
    try {
      const results = [
        await unreachable.ensureBuckets(),
        await unreachable.head({ bucket: "asset", key: "incoming/x" }),
        await unreachable.presignGet({ bucket: "asset", key: "incoming/x", expiresSec: 60 }),
        await unreachable.delete({ bucket: "asset", key: "incoming/x" }),
      ];
      for (const result of results) {
        expect(result).toMatchObject({ ok: false, reason: "unavailable" });
        const message = result.ok ? "" : result.message;
        expect(message).toContain("pnpm infra:up");
        expect(message).not.toContain("127.0.0.1");
        expect(message).not.toContain(LOCAL_MINIO.secretKey);
      }
    } finally {
      unreachable.close();
    }
  });
});
