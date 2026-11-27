import { afterEach, expect, it, vi } from "vitest";
import type { DetailApi } from "./api";
import { createProductionUpload } from "./upload";

const fileId = "00000000-0000-7000-8000-000000000001";
type Registration = Awaited<ReturnType<DetailApi["file"]>>;
const grant = (): Registration => ({
  fileId: fileId,
  clientToken: "sample-token",
  status: "pending",
  mode: "multipart",
  bucket: "test-media-1250000000",
  region: "ap-shanghai",
  key: "incoming/sample-file/sample.mp4",
  post: null,
  sts: {
    tmpSecretId: "publicfake",
    tmpSecretKey: "publicfakekey",
    sessionToken: "publicfaketoken",
    startTime: new Date(Date.now() - 60_000).toISOString(),
    expiredTime: new Date(Date.now() + 1_800_000).toISOString(),
  },
  chunkSize: 8 * 1024 * 1024,
  chunkParallel: 4,
  expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
  uploadExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  credentialsLeft: 29,
});

function setup(options: { failPart?: number; hold?: boolean } = {}) {
  const registration = grant();
  const api = {
    file: vi.fn().mockResolvedValue(registration),
    refreshCredentials: vi.fn().mockResolvedValue(grant()),
    complete: vi.fn().mockResolvedValue({ fileId: registration.fileId, status: "stored" }),
    fileStatus: vi.fn().mockResolvedValue({ fileId: registration.fileId, status: "stored" }),
  };
  const parts = new Map<number, string>();
  let failed = false;
  const requests: { method: string; url: URL; size?: number; signal?: AbortSignal | null }[] = [];
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    requests.push({
      method: init.method!,
      url,
      size: (init.body as Blob)?.size,
      signal: init.signal,
    });
    expect(url.origin).toBe("https://test-media-1250000000.cos.ap-shanghai.myqcloud.com");
    expect(new Headers(init.headers).get("authorization")).toMatch(/^q-sign-algorithm=sha1/);
    expect(init.credentials).not.toBe("include");
    if (url.searchParams.has("uploads"))
      return new Response("<Result><UploadId>sample-upload</UploadId></Result>");
    if (init.method === "GET")
      return new Response(
        `<Result><IsTruncated>false</IsTruncated>${[...parts].map(([n, tag]) => `<Part><PartNumber>${n}</PartNumber><ETag>${tag}</ETag></Part>`).join("")}</Result>`,
      );
    if (init.method === "PUT") {
      if (options.hold)
        await new Promise<void>((_, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      const n = Number(url.searchParams.get("partNumber"));
      if (!failed && n === options.failPart) {
        failed = true;
        return new Response("failed", { status: 500 });
      }
      parts.set(n, `etag${n}`);
      return new Response("", { headers: { ETag: `etag${n}` } });
    }
    return new Response("<Result><ETag>complete</ETag></Result>");
  });
  const adapter = createProductionUpload(api, {
    category: "sample_video",
    storeId: "store",
    production: {
      kind: "sample",
      orderItemId: "item",
      episodeNo: 1,
      aiUsage: { used: false, tools: [] },
    },
  });
  const file = new File([new Uint8Array(25 * 1024 * 1024)], "sample.mp4", { type: "video/mp4" });
  return { api, adapter, file, requests, registration };
}
afterEach(() => vi.unstubAllGlobals());

it("大于20MiB样片使用STS分片，入库成功后才返回fileId", async () => {
  const { api, adapter, file, requests } = setup();
  const progress = vi.fn();
  await expect(adapter.upload(file, { onProgress: progress })).resolves.toEqual({
    fileId: fileId,
  });
  expect(
    requests
      .filter((r) => r.method === "PUT")
      .sort(
        (a, b) =>
          Number(a.url.searchParams.get("partNumber")) -
          Number(b.url.searchParams.get("partNumber")),
      )
      .map((r) => r.size),
  ).toEqual([8, 8, 8, 1].map((n) => n * 1024 * 1024));
  expect(api.file.mock.calls[0]![0]).toMatchObject({
    category: "sample_video",
    sizeBytes: String(file.size),
    production: { kind: "sample", orderItemId: "item" },
  });
  expect(api.complete).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenLastCalledWith(100);
  adapter.dispose();
});

it("分片失败重试复用文件登记，只补传失败分片", async () => {
  const { api, adapter, file, requests } = setup({ failPart: 2 });
  await expect(adapter.upload(file, { onProgress: vi.fn() })).rejects.toThrow("直传失败");
  expect(api.complete).not.toHaveBeenCalled();
  await expect(adapter.upload(file, { onProgress: vi.fn() })).resolves.toEqual({
    fileId: fileId,
  });
  expect(api.file).toHaveBeenCalledTimes(1);
  expect(requests.filter((r) => r.url.searchParams.has("uploads"))).toHaveLength(1);
  expect(
    requests
      .filter((r) => r.method === "PUT")
      .map((r) => r.url.searchParams.get("partNumber"))
      .sort(),
  ).toEqual(["1", "2", "2", "3", "4"]);
  adapter.dispose();
});

it("关闭样片窗口中止正在上传的分片，不确认入库", async () => {
  const { api, adapter, file, requests } = setup({ hold: true });
  const progress = vi.fn();
  const pending = adapter.upload(file, { onProgress: progress });
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(requests.filter((r) => r.method === "PUT")).toHaveLength(4));
  adapter.dispose();
  await failed;
  expect(requests.filter((r) => r.method === "PUT").every((r) => r.signal?.aborted)).toBe(true);
  expect(api.complete).not.toHaveBeenCalled();
  expect(progress).not.toHaveBeenCalledWith(100);
});

it("分片凭证过期后续签，拒绝续签改变文件归属", async () => {
  const { api, adapter, file, registration } = setup();
  registration.expiresAt = "2000-01-01T00:00:00.000Z";
  api.refreshCredentials.mockResolvedValue({ ...grant(), key: "incoming/other-file/sample.mp4" });
  await expect(adapter.upload(file, { onProgress: vi.fn() })).rejects.toThrow("归属发生变化");
  expect(api.complete).not.toHaveBeenCalled();
  adapter.dispose();
});

it("同一文件续签后完成分片，再次确认不重复直传", async () => {
  const { api, adapter, file, requests, registration } = setup();
  registration.expiresAt = "2000-01-01T00:00:00.000Z";
  await adapter.upload(file, { onProgress: vi.fn() });
  const transferred = requests.length;
  await adapter.upload(file, { onProgress: vi.fn() });
  expect(requests).toHaveLength(transferred);
  expect(api.refreshCredentials).toHaveBeenCalledWith(fileId, expect.any(AbortSignal));
  expect(api.file).toHaveBeenCalledTimes(1);
  expect(api.complete.mock.calls[0]![1]).toBe(api.complete.mock.calls[1]![1]);
  adapter.dispose();
});

it("分片上传后等待pending与promoting入库，拒绝入库失败", async () => {
  const { api, adapter, file } = setup();
  api.complete.mockResolvedValue({ fileId: fileId, status: "pending" });
  api.fileStatus
    .mockResolvedValueOnce({ fileId: fileId, status: "promoting" })
    .mockResolvedValueOnce({ fileId: fileId, status: "rejected" });
  const progress = vi.fn();
  await expect(adapter.upload(file, { onProgress: progress })).rejects.toThrow("文件尚未成功入库");
  expect(api.fileStatus).toHaveBeenCalledTimes(2);
  expect(progress).not.toHaveBeenCalledWith(100);
  adapter.dispose();
});

it("切换样片文件取消旧分片，晚到操作不能覆盖新文件", async () => {
  const { api, adapter, file, requests } = setup({ hold: true });
  const oldProgress = vi.fn();
  const first = adapter.upload(file, { onProgress: oldProgress });
  const aborted = expect(first).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(requests.filter((r) => r.method === "PUT")).toHaveLength(4));
  const next = new File(["next"], "next.mp4", { type: "video/mp4" });
  let release!: (value: Registration) => void;
  api.file.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const second = adapter.upload(next, { onProgress: vi.fn() });
  const secondAborted = expect(second).rejects.toMatchObject({ name: "AbortError" });
  await aborted;
  expect(api.complete).not.toHaveBeenCalled();
  expect(oldProgress).not.toHaveBeenCalled();
  adapter.dispose();
  release(grant());
  await secondAborted;
});
