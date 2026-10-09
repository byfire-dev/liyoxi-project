import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STORAGE_BUCKETS, withBeforeCall } from "../types.js";
import { createCosStorage } from "./cos.js";
import { cosAuthorization, cosPostPolicy, stsAuthorization } from "./cos-signature.js";
import type { CosConfig } from "./cos.js";

const now = () => new Date("2026-01-05T04:00:00.000Z");
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
  stsIssuer: { secretId: "issuerfake", secretKey: "issuerkey" },
  worker: { secretId: "workerfake", secretKey: "workerkey" },
};
const calls: Array<{ url: URL; method: string; headers: Headers; body: string }> = [];
let server: Server;
let hung: Socket | undefined;
let hangAccepted: (() => void) | undefined;
let putMode: "normal" | "exists" | "s3" = "normal";
let versioning = "<VersioningConfiguration></VersioningConfiguration>";
let digest = "";
let origin: string;
let mode: "normal" | "overflow" | "hang" | "redirect" | "denied" | "stsDenied" = "normal";
const sockets = new Set<Socket>();
const drivers: Array<ReturnType<typeof createCosStorage>> = [];
const ref = {
  bucket: "asset" as const,
  key: "incoming/00000000-0000-7000-8000-000000000001/a.png",
};
const etag = '"fake-etag"';
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const forward: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  expect(url.protocol).toBe("https:");
  expect(
    url.hostname === "sts.tencentcloudapi.com" ||
      Object.values(config.buckets).some(
        (bucket) => url.hostname === `${bucket}.cos.ap-beijing.myqcloud.com`,
      ),
  ).toBe(true);
  const body = typeof init?.body === "string" ? init.body : "";
  calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
  return fetch(`${origin}${url.pathname}${url.search}`, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init?.headers)),
      "X-Test-Sts": String(url.hostname === "sts.tencentcloudapi.com"),
    },
  });
};
const driver = () => {
  const value = createCosStorage(config, { now, fetchImpl: forward });
  drivers.push(value);
  return value;
};
beforeAll(async () => {
  server = createServer((req, res) => {
    if (mode === "hang") {
      hung = req.socket;
      hangAccepted?.();
      return;
    }
    if (mode === "redirect") {
      res.writeHead(307, { Location: "https://other.invalid/" }).end();
      return;
    }
    if (mode === "denied") {
      res.writeHead(403).end("private-response-never-propagates");
      return;
    }
    if (req.headers["x-test-sts"] === "true") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          Response:
            mode === "stsDenied"
              ? { Error: { Code: "UnauthorizedOperation", Message: "private-upstream" } }
              : {
                  Credentials: {
                    TmpSecretId: "fake-sts-id",
                    TmpSecretKey: "fake-sts-key",
                    Token: "fake-sts-token",
                  },
                  StartTime: Math.floor(now().getTime() / 1000),
                  ExpiredTime: Math.floor(now().getTime() / 1000) + 300,
                },
        }),
      );
      return;
    }
    const url = new URL(req.url!, origin);
    if (url.searchParams.has("versioning")) {
      res.end(versioning);
      return;
    }
    if (url.searchParams.has("uploads")) {
      res.end(
        `<ListMultipartUploadsResult><IsTruncated>false</IsTruncated><Upload><Key>${ref.key}</Key><UploadId>ownedupload</UploadId></Upload><Upload><Key>${ref.key}other</Key><UploadId>otherupload</UploadId></Upload></ListMultipartUploadsResult>`,
      );
      return;
    }
    if (req.method === "HEAD") {
      res
        .writeHead(200, {
          "Content-Length": "8",
          ETag: etag,
          "x-cos-hash-crc64ecma": "123456",
          "x-cos-version-id": "version1",
          "x-cos-meta-lyx-sha256": digest,
          "x-cos-meta-lyx-content-identity": "backupidentity",
        })
        .end();
      return;
    }
    if (req.method === "GET") {
      if (mode === "overflow") {
        res.writeHead(206);
        res.end(new Uint8Array(5000));
        return;
      }
      res.writeHead(206, { ETag: etag });
      res.end(png);
      return;
    }
    if (req.method === "PUT" && req.headers["x-cos-copy-source"]) {
      res.end(`<CopyObjectResult><ETag>&quot;fake-etag&quot;</ETag></CopyObjectResult>`);
      return;
    }
    if (req.method === "PUT") {
      if (putMode !== "normal") {
        res
          .writeHead(putMode === "s3" ? 412 : 409)
          .end("<Error><Code>FileAlreadyExists</Code></Error>");
        return;
      }
      res.writeHead(200, { ETag: etag }).end();
      return;
    }
    res.writeHead(204).end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake HTTP failed");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await Promise.all(drivers.map((value) => value.close()));
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("COS 官方协议薄封装", () => {
  it("COS官方canonical中间向量与十六进制SignKey规则", () => {
    // Official request example supplies this canonical SHA1 independently of production code.
    const http =
      "get\n/exampleobject(腾讯云)\nresponse-cache-control=max-age%3D600&response-content-type=application%2Foctet-stream\ndate=Thu%2C%2016%20May%202019%2006%3A55%3A53%20GMT&host=examplebucket-1250000000.cos.ap-beijing.myqcloud.com\n";
    expect(createHash("sha1").update(http).digest("hex")).toBe(
      "54ecfe22f59d3514fdc764b87a32d8133ea611e6",
    );
    const signed = cosAuthorization({
      key: keys,
      method: "GET",
      pathname: "/exampleobject(腾讯云)",
      query: {
        "response-content-type": "application/octet-stream",
        "response-cache-control": "max-age=600",
      },
      headers: {
        Date: "Thu, 16 May 2019 06:55:53 GMT",
        Host: "examplebucket-1250000000.cos.ap-beijing.myqcloud.com",
      },
      start: 1557989753,
      end: 1557996953,
    });
    const signKey = createHmac("sha1", keys.secretKey)
      .update("1557989753;1557996953")
      .digest("hex");
    const expected = createHmac("sha1", signKey)
      .update("sha1\n1557989753;1557996953\n54ecfe22f59d3514fdc764b87a32d8133ea611e6\n")
      .digest("hex");
    expect(signed).toContain(`q-signature=${expected}`);
    expect(signed).toContain("q-header-list=date;host");
    expect(signed).toContain("q-url-param-list=response-cache-control;response-content-type");
  });
  it("TC3固定STS预期向量：独立Python按官方公式生成，非生产函数互算", () => {
    // /tmp/lyx-w301-tc3-vector.py; public invented keys; official api/1312/48202.
    const body = '{"Name":"lyx-upload","Policy":"{}","DurationSeconds":1800}';
    expect(createHash("sha256").update(body).digest("hex")).toBe(
      "5dc78e0fd2e83813039ed743d63e1890d527941dc37f0fbfe631bf5284e1ab4a",
    );
    expect(
      stsAuthorization({ secretId: "publicfakeid", secretKey: "publicfakekey" }, body, 1551113065),
    ).toBe(
      "TC3-HMAC-SHA256 Credential=publicfakeid/2019-02-25/sts/tc3_request, SignedHeaders=content-type;host, Signature=1fae9f7840ae428d5565aa78e078d02cb1a915798720ea4616a76eaefd100dd6",
    );
  });
  it("POST policy固定四桶/key/MIME/大小、10分钟，构造没有外呼", async () => {
    mode = "normal";
    const before = calls.length;
    const storage = driver();
    for (const bucket of STORAGE_BUCKETS) {
      const result = await storage.presignPost({
        ...ref,
        bucket,
        mime: "image/png",
        maxBytes: 8,
        expiresSec: 600,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("policy");
      expect(result.value.url).toBe(
        `https://${config.buckets[bucket]}.cos.ap-beijing.myqcloud.com/`,
      );
      const policy = JSON.parse(Buffer.from(result.value.fields.policy!, "base64").toString()) as {
        conditions: unknown[];
      };
      expect(policy.conditions).toContainEqual({ key: ref.key });
      expect(policy.conditions).toContainEqual(["content-length-range", 1, 8]);
      expect(result.value.fields).toMatchObject(
        cosPostPolicy(
          keys,
          Buffer.from(result.value.fields.policy!, "base64").toString(),
          Math.floor(now().getTime() / 1000),
          Math.floor(now().getTime() / 1000) + 600,
        ),
      );
    }
    expect(calls).toHaveLength(before);
    expect(
      await storage.presignPost({
        ...ref,
        key: "formal/a",
        mime: "image/png",
        maxBytes: 8,
        expiresSec: 600,
      }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    expect(storage.capabilities.versioning).toBe(false);
  });
  it("真实HTTP STS的TC3/窄prefix策略与临时开始过期时间", async () => {
    mode = "normal";
    const storage = driver();
    const result = await storage.issueSts({
      bucket: "asset",
      keyPrefix: "incoming/00000000-0000-7000-8000-000000000001/",
      durationSec: 1800,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { accessKeyId: "fake-sts-id", startTime: now() },
    });
    const call = calls.at(-1)!;
    expect(call.headers.get("Authorization")).toBe(
      stsAuthorization(config.stsIssuer!, call.body, Math.floor(now().getTime() / 1000)),
    );
    const body = JSON.parse(call.body) as { Policy: string };
    expect(body.Policy).toMatch(/^%7B/);
    const policy = JSON.parse(decodeURIComponent(body.Policy)) as {
      statement: Array<{ resource: string[]; action: string[] }>;
    };
    expect(policy.statement[0]!.resource).toEqual([
      "qcs::cos:ap-beijing:uid/1250000000:test-asset-1250000000/incoming/00000000-0000-7000-8000-000000000001/*",
    ]);
    expect(policy.statement[0]!.action).not.toContain("name/cos:PutObject");
    expect(policy.statement).toHaveLength(1);
    expect(policy.statement.flatMap((statement) => statement.action)).not.toContain(
      "name/cos:ListMultipartUploads",
    );
    mode = "stsDenied";
    expect(
      await storage.issueSts({ bucket: "asset", keyPrefix: "incoming/id/", durationSec: 1800 }),
    ).toMatchObject({ ok: false, reason: "rejected", message: "STS 未签发凭据" });
    mode = "normal";
  });
  it("批次STS仅追加exact incoming/bUUID/列表声明，bucket授权始终有精确prefix条件", async () => {
    const keyPrefix = "incoming/b00000000-0000-7000-8000-000000000002/";
    const before = calls.length;
    expect(
      await driver().issueSts({ bucket: "media", keyPrefix, durationSec: 1800 }),
    ).toMatchObject({
      ok: true,
    });
    expect(calls).toHaveLength(before + 1);
    const body = JSON.parse(calls.at(-1)!.body) as { Policy: string };
    expect(JSON.parse(decodeURIComponent(body.Policy))).toEqual({
      version: "2.0",
      statement: [
        {
          effect: "allow",
          action: [
            "name/cos:InitiateMultipartUpload",
            "name/cos:UploadPart",
            "name/cos:ListParts",
            "name/cos:CompleteMultipartUpload",
            "name/cos:AbortMultipartUpload",
          ],
          resource: [`qcs::cos:ap-beijing:uid/1250000000:test-media-1250000000/${keyPrefix}*`],
        },
        {
          effect: "allow",
          action: ["name/cos:ListMultipartUploads"],
          resource: ["qcs::cos:ap-beijing:uid/1250000000:test-media-1250000000/*"],
          condition: { string_equal: { "cos:prefix": keyPrefix } },
        },
      ],
    });
  });
  it("非法批次prefix不能签全bucket列表；非UUID单文件prefix保留无列表权限", async () => {
    const storage = driver();
    const before = calls.length;
    for (const keyPrefix of [
      "",
      "incoming/",
      "incoming/*",
      "incoming/b00000000-0000-7000-8000-000000000002/*",
      "incoming/b00000000-0000-7000-8000-000000000002/../",
      "incoming/b00000000-0000-7000-8000-000000000002/child/",
    ])
      expect(
        await storage.issueSts({ bucket: "media", keyPrefix, durationSec: 1800 }),
      ).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    expect(calls).toHaveLength(before);
    expect(
      await storage.issueSts({
        bucket: "media",
        keyPrefix: "incoming/bnot-a-uuid/",
        durationSec: 1800,
      }),
    ).toMatchObject({ ok: true });
    const body = JSON.parse(calls.at(-1)!.body) as { Policy: string };
    const policy = JSON.parse(decodeURIComponent(body.Policy)) as {
      statement: Array<{ action: string[]; resource: string[] }>;
    };
    expect(policy.statement).toHaveLength(1);
    expect(policy.statement[0]!.resource).toEqual([
      "qcs::cos:ap-beijing:uid/1250000000:test-media-1250000000/incoming/bnot-a-uuid/*",
    ]);
    expect(policy.statement.flatMap((statement) => statement.action)).not.toContain(
      "name/cos:ListMultipartUploads",
    );
  });
  it("HEAD CRC/version、非UTF8文件头、IfMatch copy和正式区真实核对", async () => {
    const storage = driver();
    expect(await storage.head(ref)).toMatchObject({
      ok: true,
      value: { size: 8, crc64: "123456", versionId: "version1" },
    });
    expect(await storage.readPrefix({ ...ref, bytes: 4096, ifMatchEtag: etag })).toEqual({
      ok: true,
      value: png,
    });
    expect(calls.at(-1)!.headers.get("If-Match")).toBe(etag);
    const copied = await storage.copy({
      src: ref,
      dst: { bucket: "asset", key: "formal/a.png" },
      ifMatchEtag: etag,
      contentType: "image/png",
      contentDisposition: "attachment",
    });
    expect(copied).toEqual({ ok: true, value: { etag } });
    expect(calls.at(-1)!.headers.get("x-cos-copy-source-if-match")).toBe(etag);
    expect(calls.at(-1)!.headers.get("Authorization")).toContain("q-ak=workerfake");
  });
  it("超限真实流/重定向/拒绝不泄漏原文，只一次请求", async () => {
    const storage = driver();
    for (const failureMode of ["overflow", "redirect", "denied"] as const) {
      mode = failureMode;
      const before = calls.length;
      const result = await storage.readPrefix({ ...ref, bytes: 4096 });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("private-response");
      expect(calls).toHaveLength(before + 1);
    }
    mode = "normal";
  });
  it("取消只exact key；列表权限prefix精确，其他对象UploadId不动", async () => {
    const before = calls.length;
    expect(await driver().abortMultipart(ref)).toEqual({ ok: true, value: undefined });
    const subset = calls.slice(before);
    const body = JSON.parse(subset[0]!.body) as { Policy: string };
    expect(JSON.parse(decodeURIComponent(body.Policy))).toMatchObject({
      statement: [
        { resource: [expect.stringContaining(ref.key)] },
        { condition: { string_equal: { "cos:prefix": ref.key } } },
      ],
    });
    expect(
      subset
        .filter((call) => call.method === "DELETE")
        .map((call) => call.url.searchParams.get("uploadId")),
    ).toEqual(["ownedupload"]);
    expect(await driver().abortMultipart({ ...ref, key: "formal/a.png" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
  });
  it("API没有worker角色，正式写删/copy受控unsupported；guard先于外呼", async () => {
    const api = createCosStorage({ ...config, worker: undefined }, { now, fetchImpl: forward });
    drivers.push(api);
    const before = calls.length;
    expect(await api.delete(ref)).toMatchObject({ ok: false, reason: "unsupported" });
    const guarded = withBeforeCall("storage", api, () => {
      throw new Error("tx guard");
    });
    await expect(guarded.abortMultipart(ref)).rejects.toThrow("tx guard");
    expect(calls).toHaveLength(before);
  });
  it("COS原生防覆盖409/版本配置；旧S3条件412不得冒充幂等", async () => {
    const storage = driver();
    const body = new Uint8Array(8);
    digest = createHash("sha256").update(body).digest("hex");
    const input = {
      bucket: "secure" as const,
      key: "backup/a",
      body,
      contentType: "application/octet-stream",
      ifAbsent: true,
      contentIdentity: "backupidentity",
    };
    expect(await storage.putObject(input)).toMatchObject({ ok: true });
    const put = calls.findLast((c) => c.method === "PUT")!;
    expect(put.headers.get("x-cos-forbid-overwrite")).toBe("true");
    expect(put.headers.has("If-None-Match")).toBe(false);
    putMode = "exists";
    expect(await storage.putObject(input)).toMatchObject({ ok: true });
    digest = "different";
    expect(await storage.putObject(input)).toMatchObject({ ok: false, reason: "rejected" });
    putMode = "s3";
    expect(await storage.putObject(input)).toMatchObject({ ok: false, reason: "rejected" });
    putMode = "normal";
    for (const value of [
      "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
      "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>",
      "bad",
    ]) {
      versioning = value;
      const before = calls.filter((c) => c.method === "PUT").length;
      expect(await storage.putObject(input)).toMatchObject({ ok: false, reason: "unsupported" });
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(before);
    }
    versioning = "<VersioningConfiguration></VersioningConfiguration>";
  });
  it("自有close取消在途真实请求并回收socket，不自动重发", async () => {
    mode = "hang";
    const storage = driver();
    const before = calls.length;
    const accepted = new Promise<void>((resolve) => {
      hangAccepted = resolve;
    });
    const result = storage.head(ref);
    await accepted;
    const socketClosed = new Promise<void>((resolve) => hung!.once("close", resolve));
    await storage.close();
    expect(await result).toMatchObject({ ok: false, reason: "unavailable" });
    await socketClosed;
    expect(hung!.destroyed).toBe(true);
    hangAccepted = undefined;
    expect(calls).toHaveLength(before + 1);
    mode = "normal";
  });
});
