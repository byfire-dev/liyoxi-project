import { describe, expect, it, vi } from "vitest";
import type { FileRegistration } from "@liyoxi/contract";
import { createAdminApi, type ApiHandlers } from "./api";
import {
  createAdminMultipartUploadPorts,
  createMultipartUploadAdapter,
  type MultipartUploadPorts,
} from "./upload-multipart";

const id = "00000000-0000-7000-8000-000000000001";
const now = Date.parse("2026-01-05T04:00:00Z");
const grant = (): FileRegistration => ({
  fileId: id,
  clientToken: "memorytoken",
  status: "pending",
  mode: "multipart",
  bucket: "test-asset-1250000000",
  region: "ap-beijing",
  key: `incoming/${id}/clip.mp4`,
  post: null,
  sts: {
    tmpSecretId: "publicfake",
    tmpSecretKey: "publicfakekey",
    sessionToken: "publicfaketoken",
    startTime: new Date(now).toISOString(),
    expiredTime: new Date(now + 1800000).toISOString(),
  },
  chunkSize: 8 * 1024 * 1024,
  chunkParallel: 4,
  expiresAt: new Date(now + 1800000).toISOString(),
  uploadExpiresAt: new Date(now + 86400000).toISOString(),
  credentialsLeft: 29,
});
const file = (chunks = 4) =>
  new File(Array(chunks).fill(new Blob([new Uint8Array(8 * 1024 * 1024)])), "clip.mp4");
const xml = (text: string, headers: HeadersInit = {}) => new Response(text, { headers });
const defaults = (): MultipartUploadPorts => ({
  register: vi.fn(async () => grant()),
  refresh: vi.fn(async () => grant()),
  complete: vi.fn(async () => ({ fileId: id, status: "stored" })),
  get: vi.fn(async () => ({ fileId: id, status: "stored" })),
  cancel: vi.fn(async () => undefined),
});
function fakeCloud(options: { failPart?: number; hold?: boolean } = {}) {
  const calls: { method: string; url: URL; headers: Headers; body?: BodyInit | null }[] = [];
  const parts = new Map<number, string>();
  let failed = false;
  let active = 0;
  let maximum = 0;
  let entered = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init!.method!;
    calls.push({ method, url, headers: new Headers(init!.headers), body: init!.body });
    expect(url.origin).toBe("https://test-asset-1250000000.cos.ap-beijing.myqcloud.com");
    expect(init!.redirect).toBe("error");
    expect(new Headers(init!.headers).get("Authorization")).toMatch(
      /^q-sign-algorithm=sha1&q-ak=publicfake/,
    );
    if (url.searchParams.has("uploads"))
      return xml(
        "<InitiateMultipartUploadResult><UploadId>owned1</UploadId></InitiateMultipartUploadResult>",
      );
    if (method === "GET")
      return xml(
        `<ListPartsResult><IsTruncated>false</IsTruncated>${[...parts].map(([number, etag]) => `<Part><PartNumber>${number}</PartNumber><ETag>${etag}</ETag></Part>`).join("")}</ListPartsResult>`,
      );
    if (method === "PUT") {
      active++;
      maximum = Math.max(active, maximum);
      try {
        if (options.hold)
          await new Promise<void>((_resolve, reject) => {
            const signal = init!.signal!;
            if (signal.aborted) reject(new Error("aborted"));
            else
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        if (options.failPart && ++entered <= 4) {
          if (entered === 4) release();
          await barrier;
        }
        await Promise.resolve();
        const number = Number(url.searchParams.get("partNumber"));
        expect((init!.body as Blob).size).toBe(8 * 1024 * 1024);
        if (!failed && number === options.failPart) {
          failed = true;
          return new Response("failed", { status: 500 });
        }
        parts.set(number, `etag${number}`);
        return xml("", { ETag: `etag${number}` });
      } finally {
        active--;
      }
    }
    return xml(
      "<CompleteMultipartUploadResult><ETag>complete</ETag></CompleteMultipartUploadResult>",
    );
  };
  return { fetchImpl, calls, parts, stats: () => ({ active, maximum }) };
}

describe("公开分块适配与真实中央客户端绑定", () => {
  it("8MB/4块，断块重试保留UploadId和token，只补缺块，完成排序", async () => {
    const ports = defaults();
    const cloud = fakeCloud({ failPart: 2 });
    const adapter = createMultipartUploadAdapter({
      ports,
      fetchImpl: cloud.fetchImpl,
      now: () => now,
    });
    const input = file();
    const progress = vi.fn();
    await expect(adapter.upload(input, { onProgress: progress })).rejects.toThrow("直传失败");
    expect(cloud.stats().active).toBe(0);
    expect(await adapter.upload(input, { onProgress: progress })).toEqual({ fileId: id });
    expect(ports.register).toHaveBeenCalledTimes(1);
    expect(cloud.calls.filter((c) => c.url.searchParams.has("uploads"))).toHaveLength(1);
    const uploaded = cloud.calls
      .filter((c) => c.method === "PUT")
      .map((c) => c.url.searchParams.get("partNumber"));
    expect(uploaded.slice(0, 4).sort()).toEqual(["1", "2", "3", "4"]);
    expect(uploaded.slice(4)).toEqual(["2"]);
    const complete = cloud.calls.at(-1)!;
    expect(complete.body).toBe(
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>etag1</ETag></Part><Part><PartNumber>2</PartNumber><ETag>etag2</ETag></Part><Part><PartNumber>3</PartNumber><ETag>etag3</ETag></Part><Part><PartNumber>4</PartNumber><ETag>etag4</ETag></Part></CompleteMultipartUpload>",
    );
    expect(cloud.stats().maximum).toBe(4);
    expect(progress).toHaveBeenLastCalledWith(100);
    adapter.close();
  });
  it("过期STS单飞续签，保持归属；不把短密钥写到公开返回或持久存储", async () => {
    const ports = defaults();
    const current = grant();
    current.expiresAt = new Date(now).toISOString();
    ports.register = vi.fn(async () => current);
    const storage = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    try {
      const cloud = fakeCloud();
      const adapter = createMultipartUploadAdapter({
        ports,
        fetchImpl: cloud.fetchImpl,
        now: () => now,
      });
      expect(await adapter.upload(file(), { onProgress: vi.fn() })).toEqual({ fileId: id });
      expect(ports.refresh).toHaveBeenCalledTimes(1);
      expect(storage.setItem).not.toHaveBeenCalled();
      adapter.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("取消等所有真实fake fetch停止；晚进度/完成丢弃，取消仅本file", async () => {
    const ports = defaults();
    const cloud = fakeCloud({ hold: true });
    const progress = vi.fn();
    const adapter = createMultipartUploadAdapter({
      ports,
      fetchImpl: cloud.fetchImpl,
      now: () => now,
    });
    const input = file();
    const pending = adapter.upload(input, { onProgress: progress });
    const failure = expect(pending).rejects.toThrow();
    for (let n = 0; n < 100 && cloud.stats().active < 4; n++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(cloud.stats().active).toBe(4);
    await adapter.cancel(input);
    await failure;
    expect(cloud.stats().active).toBe(0);
    expect(ports.cancel).toHaveBeenCalledExactlyOnceWith(id, expect.stringMatching(/^cancel:/));
    expect(ports.complete).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    adapter.close();
  });
  it("取消登记竞态仍取消随后返回的真实file；不开始cloud", async () => {
    const ports = defaults();
    let resolve!: (value: FileRegistration) => void;
    ports.register = vi.fn(
      () =>
        new Promise<FileRegistration>((r) => {
          resolve = r;
        }),
    );
    const cloud = fakeCloud();
    const adapter = createMultipartUploadAdapter({
      ports,
      fetchImpl: cloud.fetchImpl,
      now: () => now,
    });
    const input = file(1);
    const upload = adapter.upload(input, { onProgress: vi.fn() });
    const rejected = expect(upload).rejects.toThrow("取消");
    const cancel = adapter.cancel(input);
    resolve(grant());
    await cancel;
    await rejected;
    expect(ports.cancel).toHaveBeenCalledExactlyOnceWith(id, expect.stringMatching(/^cancel:/));
    expect(cloud.calls).toHaveLength(0);
    adapter.close();
  });
  it("三文件上限和close取消，不为挂起请求增加无界排队", async () => {
    const ports = defaults();
    const cloud = fakeCloud({ hold: true });
    const adapter = createMultipartUploadAdapter({
      ports,
      fetchImpl: cloud.fetchImpl,
      now: () => now,
    });
    const uploads = [file(1), file(1), file(1)].map((input) =>
      adapter.upload(input, { onProgress: vi.fn() }),
    );
    const outcome = Promise.allSettled(uploads);
    await expect(adapter.upload(file(1), { onProgress: vi.fn() })).rejects.toThrow("3个");
    adapter.close();
    expect((await outcome).every((r) => r.status === "rejected")).toBe(true);
    expect(cloud.stats().active).toBe(0);
  });
  it("确认与取消的同意图重试保留key，成功后凭据会话释放", async () => {
    const ports = defaults();
    const cloud = fakeCloud();
    let completes = 0;
    ports.complete = vi.fn(async () => {
      if (++completes === 1) throw new Error("transport");
      return { fileId: id, status: "stored" };
    });
    const adapter = createMultipartUploadAdapter({
      ports,
      fetchImpl: cloud.fetchImpl,
      now: () => now,
    });
    const input = file(1);
    await expect(adapter.upload(input, { onProgress: vi.fn() })).rejects.toThrow("transport");
    const before = cloud.calls.length;
    await adapter.upload(input, { onProgress: vi.fn() });
    expect(cloud.calls).toHaveLength(before);
    const completed = vi.mocked(ports.complete).mock.calls;
    expect(completed[0]![1]).toBe(completed[1]![1]);
    let cancels = 0;
    ports.cancel = vi.fn(async () => {
      if (++cancels === 1) throw new Error("cancel transport");
    });
    const pendingFile = file(1);
    let resolve!: (value: FileRegistration) => void;
    ports.register = vi.fn(
      () =>
        new Promise<FileRegistration>((r) => {
          resolve = r;
        }),
    );
    const upload = adapter.upload(pendingFile, { onProgress: vi.fn() });
    const rejected = expect(upload).rejects.toThrow("取消");
    const cancel = adapter.cancel(pendingFile);
    const failure = expect(cancel).rejects.toThrow("cancel transport");
    resolve(grant());
    await failure;
    await rejected;
    await expect(adapter.upload(pendingFile, { onProgress: vi.fn() })).rejects.toThrow(
      "取消尚未完成",
    );
    await adapter.cancel(pendingFile);
    const cancelled = vi.mocked(ports.cancel).mock.calls;
    expect(cancelled[0]![1]).toBe(cancelled[1]![1]);
    adapter.close();
  });
  it("登记失败不缓存拒绝Promise；重试保留原token", async () => {
    const ports = defaults();
    let calls = 0;
    ports.register = vi.fn(async () => {
      if (++calls === 1) throw new Error("register transport");
      return grant();
    });
    const cloud = fakeCloud();
    const adapter = createMultipartUploadAdapter({
      ports,
      fetchImpl: cloud.fetchImpl,
      now: () => now,
    });
    const input = file(1);
    await expect(adapter.upload(input, { onProgress: vi.fn() })).rejects.toThrow(
      "register transport",
    );
    expect(cloud.calls).toHaveLength(0);
    expect(await adapter.upload(input, { onProgress: vi.fn() })).toEqual({ fileId: id });
    const registration = vi.mocked(ports.register).mock.calls;
    expect(registration).toHaveLength(2);
    expect(registration[0]![1]).toBe(registration[1]![1]);
    adapter.close();
  });
  it("云Complete响应未知后明确NoSuchUpload，仅由中央业务确认接口决定成功或拒绝", async () => {
    for (const rejectBusiness of [false, true]) {
      const requests: Request[] = [];
      const api = createAdminApi({
        build: "test",
        baseUrl: "https://admin.example.test",
        handlers: {
          redirectToLogin: vi.fn(),
          stepUp: vi.fn(async () => false),
          refreshAccess: vi.fn(),
          invalidateQueries: vi.fn(),
          notify: vi.fn(),
          showBlocked: vi.fn(),
          buildMismatch: vi.fn(),
        },
        fetch: async (request) => {
          requests.push(request.clone());
          return new Response(
            JSON.stringify(
              rejectBusiness
                ? {
                    error: "UPLOAD_REJECTED",
                    message: "上传拒绝",
                    details: { rejectReason: "size_mismatch" },
                  }
                : { data: { fileId: id, status: "stored" } },
            ),
            {
              status: rejectBusiness ? 400 : 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        },
      });
      const ports = defaults();
      ports.complete = createAdminMultipartUploadPorts(api.client, { category: "poster" }).complete;
      const cloud = fakeCloud();
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === "POST" && url.searchParams.has("uploadId")) {
          await cloud.fetchImpl(input, init);
          throw new Error("complete response unknown");
        }
        if (init?.method === "GET")
          return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
        return cloud.fetchImpl(input, init);
      };
      const adapter = createMultipartUploadAdapter({ ports, fetchImpl, now: () => now });
      const input = file(1);
      const progress = vi.fn();
      await expect(adapter.upload(input, { onProgress: progress })).rejects.toThrow(
        "complete response unknown",
      );
      expect(requests).toHaveLength(0);
      const retry = adapter.upload(input, { onProgress: progress });
      if (rejectBusiness) {
        await expect(retry).rejects.toThrow("上传确认失败");
        expect(progress.mock.calls.flat()).not.toContain(100);
      } else expect(await retry).toEqual({ fileId: id });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.method).toBe("POST");
      expect(requests[0]!.url).toBe(`https://admin.example.test/api/v1/admin/files/${id}/complete`);
      expect(cloud.calls.filter((c) => c.url.searchParams.has("uploads"))).toHaveLength(1);
      expect(cloud.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
      adapter.close();
    }
  });
  it("未尝试Complete及一般云错误不可借NoSuchUpload绕过业务确认", async () => {
    const cases = [
      { beforeComplete: true, status: 404, code: "NoSuchUpload" },
      { beforeComplete: false, status: 403, code: "NoSuchUpload" },
      { beforeComplete: false, status: 500, code: "NoSuchUpload" },
      { beforeComplete: false, status: 404, code: "NoSuchKey" },
    ];
    for (const scenario of cases) {
      const ports = defaults();
      const cloud = fakeCloud(scenario.beforeComplete ? { failPart: 1 } : {});
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === "POST" && url.searchParams.has("uploadId")) {
          await cloud.fetchImpl(input, init);
          throw new Error("complete response unknown");
        }
        if (init?.method === "GET")
          return new Response(`<Error><Code>${scenario.code}</Code></Error>`, {
            status: scenario.status,
          });
        return cloud.fetchImpl(input, init);
      };
      const adapter = createMultipartUploadAdapter({ ports, fetchImpl, now: () => now });
      const input = file(scenario.beforeComplete ? 4 : 1);
      await expect(adapter.upload(input, { onProgress: vi.fn() })).rejects.toThrow();
      await expect(adapter.upload(input, { onProgress: vi.fn() })).rejects.toThrow("直传失败");
      expect(ports.complete).not.toHaveBeenCalled();
      expect(cloud.calls.filter((c) => c.url.searchParams.has("uploads"))).toHaveLength(1);
      adapter.close();
    }
  });
  it("production ports经中央typed请求鉴权/header/required同意图key，none不缓存凭据", async () => {
    const calls: Request[] = [];
    const handlers = {
      redirectToLogin: vi.fn(),
      stepUp: vi.fn(async () => false),
      refreshAccess: vi.fn(),
      invalidateQueries: vi.fn(),
      notify: vi.fn(),
      showBlocked: vi.fn(),
      buildMismatch: vi.fn(),
    } satisfies ApiHandlers;
    const api = createAdminApi({
      build: "test",
      baseUrl: "https://admin.example.test",
      handlers,
      fetch: async (request) => {
        calls.push(request.clone());
        return new Response(
          JSON.stringify({
            data:
              request.url.endsWith("refresh-credentials") || request.url.endsWith("/files")
                ? grant()
                : { fileId: id, status: "promoting" },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const ports = createAdminMultipartUploadPorts(api.client, { category: "poster" });
    await ports.register(file(1), "token1");
    await ports.refresh(id);
    await ports.complete(id, "same-complete-intent");
    await ports.complete(id, "same-complete-intent");
    await ports.cancel(id);
    expect(await calls[0]!.json()).toMatchObject({
      category: "poster",
      clientToken: "token1",
      sizeBytes: "8388608",
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "POST", "POST", "POST"]);
    expect(
      calls.every((c) => c.headers.get("X-LYX-Admin") === "1" && c.credentials === "same-origin"),
    ).toBe(true);
    expect(calls[2]!.headers.get("Idempotency-Key")).toBe(calls[3]!.headers.get("Idempotency-Key"));
    expect(calls[1]!.url).toBe(
      `https://admin.example.test/api/v1/admin/files/${id}/refresh-credentials`,
    );
  });
});
