import { expect, it, vi } from "vitest";
import {
  createMultipartUploadAdapter,
  type MultipartUploadGrant,
  type MultipartUploadPorts,
} from "./upload-multipart";
const now = Date.parse("2026-10-09T03:00:00Z");
const grant: MultipartUploadGrant = {
  fileId: "00000000-0000-7000-8000-000000000001",
  mode: "multipart",
  bucket: "test-media-1250000000",
  region: "ap-beijing",
  key: "incoming/b00000000-0000-7000-8000-000000000002/original.mp4",
  prefix: "incoming/b00000000-0000-7000-8000-000000000002/",
  post: null,
  sts: {
    tmpSecretId: "fictional-public",
    tmpSecretKey: "fictional-key",
    sessionToken: "fictional-token",
    startTime: new Date(now).toISOString(),
    expiredTime: new Date(now + 1800_000).toISOString(),
  },
  chunkSize: 8 * 1024 * 1024,
  chunkParallel: 4,
  expiresAt: new Date(now + 1800_000).toISOString(),
};
function ports(): MultipartUploadPorts {
  return {
    register: vi.fn(async () => grant),
    refresh: vi.fn(async () => grant),
    complete: vi.fn(async () => ({ fileId: grant.fileId, status: "stored" })),
    get: vi.fn(async () => ({ fileId: grant.fileId, status: "stored" })),
    cancel: vi.fn(async () => undefined),
  };
}
const response = (text: string, headers?: HeadersInit) => new Response(text, { headers });
const listed = (uploads: string, truncated = false) =>
  `<ListMultipartUploadsResult><Bucket>${grant.bucket}</Bucket><Prefix>${grant.prefix}</Prefix><IsTruncated>${truncated}</IsTruncated>${uploads}</ListMultipartUploadsResult>`;
const upload = (id: string, key = grant.key) =>
  `<Upload><Key>${key}</Key><UploadId>${id}</UploadId></Upload>`;

it("新adapter和新File模拟刷新：exactkey找唯一原UploadId，只补缺块，不注册/Init", async () => {
  const calls: { method: string; url: URL; body?: BodyInit | null }[] = [];
  const api = ports();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ method: init!.method!, url, body: init!.body });
    expect(url.origin).toBe(`https://${grant.bucket}.cos.${grant.region}.myqcloud.com`);
    expect(init?.redirect).toBe("error");
    if (url.searchParams.has("uploads")) {
      expect(url.pathname).toBe("/");
      expect(url.searchParams.get("prefix")).toBe(grant.prefix);
      expect(url.searchParams.get("max-uploads")).toBe("1000");
      return response(
        listed(upload("original-upload") + upload("prefix-neighbor", grant.key + "-other")),
      );
    }
    expect(url.searchParams.get("uploadId")).toBe("original-upload");
    if (init!.method === "GET")
      return response(
        "<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><Size>8388608</Size><ETag>etag1</ETag></Part></ListPartsResult>",
      );
    if (init!.method === "PUT") {
      expect(url.searchParams.get("partNumber")).toBe("2");
      expect((init!.body as Blob).size).toBe(1);
      return response("", { ETag: "etag2" });
    }
    return response(
      "<CompleteMultipartUploadResult><ETag>complete</ETag></CompleteMultipartUploadResult>",
    );
  };
  const adapter = createMultipartUploadAdapter({ ports: api, fetchImpl, now: () => now });
  const file = new File([new Uint8Array(8 * 1024 * 1024), "x"], "original.mp4");
  await expect(adapter.upload(file, { onProgress: vi.fn() }, { grant })).resolves.toEqual({
    fileId: grant.fileId,
  });
  expect(api.register).not.toHaveBeenCalled();
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(
    calls.filter((call) => call.method === "POST" && call.url.searchParams.has("uploads")),
  ).toHaveLength(0);
  expect(String(calls.at(-1)!.body)).toMatch(
    /<PartNumber>1<\/PartNumber>.*<PartNumber>2<\/PartNumber>/,
  );
  adapter.close();
});
it("未知Complete/0候选与多个候选都停止，不Init、不PUT、不complete覆盖", async () => {
  for (const result of [listed(""), listed(upload("a") + upload("b"))]) {
    const api = ports();
    const calls: string[] = [];
    const adapter = createMultipartUploadAdapter({
      ports: api,
      now: () => now,
      fetchImpl: async (_input, init) => {
        calls.push(init!.method!);
        return response(result);
      },
    });
    await expect(
      adapter.upload(new File(["x"], "original.mp4"), { onProgress: vi.fn() }, { grant }),
    ).rejects.toThrow();
    expect(calls).toEqual(["GET"]);
    expect(api.complete).not.toHaveBeenCalled();
    expect(api.register).not.toHaveBeenCalled();
    adapter.close();
  }
});
it("恢复响应严格归属/有界，未知truncation与跨prefix返回都拒绝", async () => {
  for (const result of [
    listed(upload("a", "foreign/key")),
    listed(upload("a")).replace("<IsTruncated>false", "<IsTruncated>unknown"),
    "x".repeat(65537),
  ]) {
    const api = ports();
    const adapter = createMultipartUploadAdapter({
      ports: api,
      now: () => now,
      fetchImpl: async () => response(result),
    });
    await expect(
      adapter.upload(new File(["x"], "original.mp4"), { onProgress: vi.fn() }, { grant }),
    ).rejects.toThrow();
    expect(api.complete).not.toHaveBeenCalled();
    adapter.close();
  }
});
it("关闭发生在恢复查询中：真实AbortSignal中止后无PUT/complete/晚到进度", async () => {
  const api = ports();
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const progress = vi.fn();
  const adapter = createMultipartUploadAdapter({
    ports: api,
    now: () => now,
    fetchImpl: async (_input, init) => {
      entered();
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("取消", "AbortError")),
          { once: true },
        );
      });
    },
  });
  const pending = adapter.upload(
    new File(["x"], "original.mp4"),
    { onProgress: progress },
    { grant },
  );
  const rejected = expect(pending).rejects.toThrow();
  await enteredPromise;
  adapter.close();
  await rejected;
  expect(api.complete).not.toHaveBeenCalled();
  expect(progress).not.toHaveBeenCalled();
});
