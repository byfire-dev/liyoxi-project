import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createCosStorage } from "./cos.js";
import type { CosConfig } from "./cos.js";

const key = "daily/2026-10-14.dump.age",
  monthly = "monthly/2026-10-14.dump.age";
const bytes = new Uint8Array([1, 3, 5, 7]);
const config: CosConfig = {
  region: "ap-beijing",
  buckets: {
    secure: "secure-1250000000",
    asset: "asset-1250000000",
    media: "media-1250000000",
    pub: "pub-1250000000",
  },
  signer: { secretId: "publicsigner", secretKey: "publicsignerkey" },
  worker: { secretId: "publicworker", secretKey: "publicworkerkey" },
  backup: {
    bucket: "backup-1250000001",
    prefix: "stg/",
    region: "ap-shanghai",
    key: { secretId: "publicbackup", secretKey: "publicbackupkey" },
  },
};
const input = () => ({
  key,
  maxBytes: bytes.length,
  signal: new AbortController().signal,
  body: async function* () {
    yield bytes;
  },
});
function setup(settings = config) {
  const calls: Array<{ url: URL; method: string; headers: Headers; body: unknown }> = [];
  let error = false;
  const fetchImpl = vi.fn<typeof fetch>(async (address, init) => {
    const url = new URL(String(address)),
      headers = new Headers(init?.headers),
      method = init?.method ?? "GET";
    calls.push({ url, method, headers, body: init?.body });
    const xml = (text: string) => new Response(text, { status: 200 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "HEAD")
      return new Response(null, {
        status: 200,
        headers: { "content-length": String(bytes.length), etag: '"stored"' },
      });
    if (url.searchParams.has("uploads"))
      return xml(
        "<InitiateMultipartUploadResult><UploadId>own_upload</UploadId></InitiateMultipartUploadResult>",
      );
    if (url.searchParams.has("partNumber"))
      return new Response(null, { status: 200, headers: { etag: '"part1"' } });
    if (error)
      return xml("<Error><Code>InternalError</Code><Message>private-body</Message></Error>");
    if (method === "POST")
      return xml(
        "<CompleteMultipartUploadResult><ETag>&quot;stored&quot;</ETag></CompleteMultipartUploadResult>",
      );
    return xml("<CopyObjectResult><ETag>&quot;stored&quot;</ETag></CopyObjectResult>");
  });
  return {
    calls,
    fetchImpl,
    setError: () => {
      error = true;
    },
    driver: createCosStorage(settings, { now: () => new Date("2026-10-14T00:00:00Z"), fetchImpl }),
  };
}

it("COS显式异地备份target和独立key、上传/HEAD/条件COPY协议；200内含Error不冒充成功", async () => {
  const { driver, calls, setError } = setup();
  try {
    expect(await driver.putBackupStream(input())).toEqual({
      ok: true,
      value: {
        size: bytes.length,
        etag: '"stored"',
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    expect(
      await driver.copyBackup({
        srcKey: key,
        dstKey: monthly,
        ifMatchEtag: '"stored"',
        signal: new AbortController().signal,
      }),
    ).toEqual({ ok: true, value: { size: bytes.length, etag: '"stored"' } });
    expect(
      calls.every(
        (call) =>
          call.url.hostname === "backup-1250000001.cos.ap-shanghai.myqcloud.com" &&
          call.url.pathname.startsWith("/stg/") &&
          call.headers.get("authorization")?.includes("q-ak=publicbackup"),
      ),
    ).toBe(true);
    expect(calls.find((call) => call.url.searchParams.has("partNumber"))?.body).toEqual(bytes);
    const copy = calls.find((call) => call.headers.has("x-cos-copy-source"));
    expect(copy?.headers.get("x-cos-copy-source")).toBe(
      `backup-1250000001.cos.ap-shanghai.myqcloud.com/stg/${key}`,
    );
    expect(copy?.headers.get("x-cos-copy-source-if-match")).toBe('"stored"');
    expect(
      calls
        .filter((call) => call.method === "HEAD")
        .every((call) => call.headers.get("if-match") === '"stored"'),
    ).toBe(true);
    calls.length = 0;
    setError();
    expect(await driver.putBackupStream(input())).toMatchObject({ ok: false });
    expect(
      calls.filter((call) => call.method === "POST" && call.url.searchParams.has("uploadId")),
    ).toHaveLength(1);
    expect(calls.filter((call) => call.method === "HEAD")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(
      await driver.copyBackup({
        srcKey: key,
        dstKey: monthly,
        ifMatchEtag: '"stored"',
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: false });
  } finally {
    await driver.close();
  }
});

it("COS关闭取消实际源并等待finally，只清own multipart；兄弟driver保持可用", async () => {
  const one = setup(),
    sibling = setup();
  let ready!: () => void,
    cleaned = false;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = one.driver.putBackupStream({
    ...input(),
    body: async function* (signal) {
      try {
        ready();
        yield bytes.subarray(0, 1);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        cleaned = true;
      }
    },
  });
  try {
    await entered;
    await one.driver.close();
    expect(await pending).toMatchObject({ ok: false });
    expect(cleaned).toBe(true);
    expect(
      one.calls
        .filter((call) => call.method === "DELETE")
        .map((call) => call.url.searchParams.get("uploadId")),
    ).toEqual(["own_upload"]);
    expect(one.calls.filter((call) => call.url.searchParams.has("partNumber"))).toHaveLength(0);
    expect(await sibling.driver.putBackupStream(input())).toMatchObject({ ok: true });
  } finally {
    await one.driver.close();
    await sibling.driver.close();
    await pending;
  }
});

it("未配或仅API signer不读源不联网；非法日期、超界、借业务桶在IO前拒绝", async () => {
  const { worker: _worker, ...signerOnly } = config;
  for (const settings of [{ ...config, backup: undefined }, signerOnly, config]) {
    const { driver, fetchImpl } = setup(settings);
    const body = vi.fn(() => input().body());
    try {
      const invalid = settings === config ? { key: "daily/2026-02-30.dump.age" } : {};
      expect(await driver.putBackupStream({ ...input(), ...invalid, body })).toMatchObject({
        ok: false,
        reason: settings === config ? "rejected" : "unconfigured",
      });
      if (settings === config)
        expect(
          await driver.putBackupStream({ ...input(), maxBytes: 2 * 1024 ** 3 + 1, body }),
        ).toMatchObject({ ok: false, reason: "rejected" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(body).not.toHaveBeenCalled();
    } finally {
      await driver.close();
    }
  }
  for (const target of [
    { bucket: config.buckets.asset, prefix: "backup/" },
    { bucket: config.buckets.secure, prefix: "" },
  ]) {
    expect(() => setup({ ...config, backup: target })).toThrow();
  }
});
