import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../request";
import { createUploadApi, type FileStatus, type Registration } from "./api";
import { clientToken, md5, sha1 } from "./hash";
import {
  awaitUpload,
  createUpload,
  createUploadQueue,
  type UploadContext,
  type UploadDeps,
} from "./queue";
const ID = "00000000-0000-4000-8000-000000000001";
const ticket: Registration = {
  fileId: ID,
  clientToken: "token",
  status: "pending",
  mode: "post",
  bucket: "incoming",
  region: "local",
  key: `incoming/${ID}`,
  post: { url: "http://storage.invalid", fields: { key: `incoming/${ID}`, policy: "fake" } },
  sts: null,
  chunkSize: null,
  chunkParallel: null,
  expiresAt: "2030-01-01T00:00:00Z",
  uploadExpiresAt: "2030-01-02T00:00:00Z",
  credentialsLeft: 30,
};
const status = (value: FileStatus["status"]): FileStatus => ({
  fileId: ID,
  category: "profile_image",
  status: value,
  rejectReason: null,
  declaredSizeBytes: "100",
  sizeBytes: "100",
  mime: "image/png",
  moderationState: "pass",
  storedAt: null,
  uploadExpiresAt: null,
  createdAt: "2026-01-01T00:00:00Z",
});
const error = (symbol: ApiError["error"], details?: unknown) =>
  new ApiError({ error: symbol, message: "失败", status: 409, requestId: "test", details });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function harness() {
  let context: UploadContext = { token: "owner", storeId: ID, revision: 1 };
  let key = 0;
  const deps: UploadDeps = {
    context: () => context,
    api: {
      register: vi.fn(async () => ({ items: [ticket] })),
      refresh: vi.fn(async () => ticket),
      complete: vi.fn(async () => status("promoting")),
      get: vi.fn(async () => status("stored")),
      cancel: vi.fn(async () => status("expired")),
    },
    post: vi.fn(() => ({ done: Promise.resolve(), abort: vi.fn() })),
    head: vi.fn(async () => new Uint8Array([1, 2, 3])),
    now: () => 0,
    sleep: vi.fn(async () => {}),
    key: (name) => `${name}:${++key}`,
  };
  const job = createUpload(
    deps,
    { path: "temp.png", name: "photo.png", size: 100 },
    "profile_image",
  );
  return {
    deps,
    job,
    change: () => {
      context = { ...context, storeId: "other", revision: 2 };
    },
  };
}
describe("续传摘要", () => {
  it.each(["", "abc", "你好", "a".repeat(64), "b".repeat(1000)])(
    "摘要与独立标准实现一致 %s",
    (value) => {
      expect(md5(new TextEncoder().encode(value))).toBe(
        createHash("md5").update(value).digest("hex"),
      );
      expect(sha1(value)).toBe(createHash("sha1").update(value).digest("hex"));
    },
  );
  it("D7精确元数据及首256KB；重选同文件稳定，不同归属与分类不同", () => {
    const data = new Uint8Array(300 * 1024).fill(7);
    const fingerprint = {
      storeId: ID,
      category: "pay_receipt",
      size: data.length,
      durationMs: 0,
      width: 0,
      height: 0,
    };
    const expected = createHash("sha1")
      .update(
        `${ID}|pay_receipt|${data.length}|0|0×0|${createHash("md5")
          .update(data.subarray(0, 256 * 1024))
          .digest("hex")}`,
      )
      .digest("hex");
    expect(clientToken(fingerprint, data)).toBe(expected);
    data[data.length - 1] = 9;
    expect(clientToken(fingerprint, data)).toBe(expected);
    expect(clientToken({ ...fingerprint, category: "profile_image" }, data)).not.toBe(expected);
    expect(clientToken({ ...fingerprint, storeId: "other" }, data)).not.toBe(expected);
  });
});
describe("post四步与重试", () => {
  it("跨网格队列也只顺序执行，前一个失败不会饿死后项", async () => {
    const queue = createUploadQueue(),
      first = deferred<void>(),
      seen: string[] = [];
    const a = queue.add(async () => {
      seen.push("a");
      await first.promise;
      throw new Error("直传断网");
    });
    const failed = expect(a).rejects.toThrow("直传断网");
    const b = queue.add(async () => {
      seen.push("b");
      return "stored";
    });
    await vi.waitFor(() => expect(seen).toEqual(["a"]));
    first.resolve();
    await failed;
    expect(await b).toBe("stored");
    expect(seen).toEqual(["a", "b"]);
  });
  it("登记、直传、确认、每秒查询stored，并行start只执行一次", async () => {
    const { job, deps } = harness();
    const a = job.start(),
      b = job.start();
    expect(a).toBe(b);
    expect((await a)?.status).toBe("stored");
    expect(deps.api.register).toHaveBeenCalledTimes(1);
    expect(deps.post).toHaveBeenCalledTimes(1);
    expect(deps.api.complete).toHaveBeenCalledWith(ID, "file_complete:1");
    expect(deps.sleep).toHaveBeenCalledWith(1000);
    expect(job.snapshot().status).toBe("stored");
  });
  it("直传失败保留登记与token，重试再传后确认", async () => {
    const { job, deps } = harness();
    vi.mocked(deps.post).mockReturnValueOnce({
      done: Promise.reject(new Error("断网")),
      abort: vi.fn(),
    });
    await job.start();
    expect(job.snapshot().status).toBe("failed");
    await job.retry();
    expect(deps.api.register).toHaveBeenCalledTimes(1);
    expect(deps.head).toHaveBeenCalledTimes(1);
    expect(deps.post).toHaveBeenCalledTimes(2);
    expect(job.snapshot().status).toBe("stored");
  });
  it("UPLOAD_NOT_FOUND补传与CONFIRM_IN_PROGRESS均沿同一确认键，refresh无缓存", async () => {
    const { job, deps } = harness();
    vi.mocked(deps.api.complete)
      .mockRejectedValueOnce(error("UPLOAD_NOT_FOUND"))
      .mockRejectedValueOnce(error("CONFIRM_IN_PROGRESS"));
    await job.start();
    expect(deps.post).toHaveBeenCalledTimes(2);
    expect(deps.api.refresh).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.api.complete).mock.calls.map((args) => args[1])).toEqual([
      "file_complete:1",
      "file_complete:1",
      "file_complete:1",
    ]);
  });
  it("过期表单先刷新再直传；不依据本地大小猜通道", async () => {
    const { job, deps } = harness();
    vi.mocked(deps.api.register).mockResolvedValue({
      items: [{ ...ticket, expiresAt: "1970-01-01T00:00:00Z" }],
    });
    await job.start();
    expect(deps.api.refresh).toHaveBeenCalledTimes(1);
    const other = harness();
    vi.mocked(other.deps.api.register).mockResolvedValue({
      items: [{ ...ticket, mode: "multipart", post: null }],
    });
    await other.job.start();
    expect(other.deps.post).not.toHaveBeenCalled();
    expect(other.job.snapshot()).toMatchObject({ status: "failed", canDelegate: true });
  });
  it("FILE_TOO_LARGE保留canDelegate；未知状态和内容封禁不交业务", async () => {
    const { job, deps } = harness();
    vi.mocked(deps.api.register).mockRejectedValueOnce(
      error("FILE_TOO_LARGE", { canDelegate: true }),
    );
    expect(await job.start()).toBeNull();
    expect(job.snapshot().canDelegate).toBe(true);
    for (const value of [{ ...status("stored"), moderationState: "block" }, status("future")]) {
      const other = harness();
      vi.mocked(other.deps.api.complete).mockResolvedValue(value);
      expect(await other.job.start()).toBeNull();
      expect(other.job.snapshot().status).toBe("failed");
    }
  });
  it("取消直传会abort且精确cancel登记；停止promoting不继续get", async () => {
    const { job, deps } = harness();
    const send = deferred<void>(),
      abort = vi.fn();
    vi.mocked(deps.post).mockReturnValue({ done: send.promise, abort });
    const work = job.start();
    await vi.waitFor(() => expect(deps.post).toHaveBeenCalled());
    await job.cancel();
    send.resolve();
    await work;
    expect(abort).toHaveBeenCalled();
    expect(deps.api.cancel).toHaveBeenCalledWith(ID, "file_cancel:2");
    expect(deps.api.complete).not.toHaveBeenCalled();
    const other = harness(),
      sleep = deferred<void>();
    vi.mocked(other.deps.sleep).mockReturnValue(sleep.promise);
    const work2 = other.job.start();
    await vi.waitFor(() => expect(other.deps.sleep).toHaveBeenCalled());
    other.job.dispose();
    sleep.resolve();
    await work2;
    expect(other.deps.api.get).not.toHaveBeenCalled();
  });
  it("上下文变化/关闭丢弃登记迟到回复，不取消到新门店", async () => {
    const { job, deps, change } = harness();
    const response = deferred<{ items: Registration[] }>();
    vi.mocked(deps.api.register).mockReturnValue(response.promise);
    const work = job.start();
    await vi.waitFor(() => expect(deps.api.register).toHaveBeenCalled());
    change();
    response.resolve({ items: [ticket] });
    expect(await work).toBeNull();
    expect(deps.post).not.toHaveBeenCalled();
    expect(deps.api.cancel).not.toHaveBeenCalled();
    expect(job.snapshot().fileId).toBeNull();
  });
  it("切后台中止直传，迅速回前台等旧任务结束后沿原登记与确认键续传", async () => {
    const { job, deps } = harness();
    const send = deferred<void>(),
      abort = vi.fn();
    vi.mocked(deps.post).mockReturnValueOnce({ done: send.promise, abort });
    const work = job.start();
    await vi.waitFor(() => expect(deps.post).toHaveBeenCalled());
    job.pause();
    const resumed = job.retry();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(job.snapshot().status).toBe("paused");
    send.resolve();
    expect(await work).toBeNull();
    expect((await resumed)?.status).toBe("stored");
    expect(deps.post).toHaveBeenCalledTimes(2);
    expect(deps.api.register).toHaveBeenCalledTimes(1);
    expect(deps.api.complete).toHaveBeenCalledWith(ID, "file_complete:1");
    expect(deps.api.cancel).not.toHaveBeenCalled();
  });
  it("原页面等待跨暂停恢复，最终拿到stored；已知promoting暂停后取消只停轮询", async () => {
    const { job, deps } = harness(),
      send = deferred<void>();
    vi.mocked(deps.post).mockReturnValueOnce({ done: send.promise, abort: vi.fn() });
    const result = awaitUpload(job);
    await vi.waitFor(() => expect(deps.post).toHaveBeenCalled());
    job.pause();
    send.resolve();
    await vi.waitFor(() => expect(job.snapshot().status).toBe("paused"));
    const resumed = job.retry();
    expect((await result)?.status).toBe("stored");
    await resumed;
    expect((await job.start())?.fileId).toBe(ID);
    const other = harness(),
      timer = deferred<void>();
    vi.mocked(other.deps.sleep).mockReturnValue(timer.promise);
    other.deps.cancelSleep = () => timer.resolve();
    const waiting = other.job.start();
    await vi.waitFor(() => expect(other.deps.sleep).toHaveBeenCalled());
    other.job.pause();
    await other.job.cancel();
    await waiting;
    expect(other.deps.api.cancel).not.toHaveBeenCalled();
    expect(other.deps.api.get).not.toHaveBeenCalled();
  });
});
it("公共API兼容pay_receipt PDF与两种执照归属；签发不带幂等键", async () => {
  const call = vi.fn(async () => null) as unknown as Parameters<typeof createUploadApi>[0];
  const api = createUploadApi(call);
  await api.register({
    category: "pay_receipt",
    files: [{ fileName: "receipt.pdf", sizeBytes: "100", clientToken: "same" }],
  });
  for (const licenseKind of ["business_license", "branch_license"] as const)
    await api.register({
      category: "kyc_license",
      licenseKind,
      files: [{ fileName: "license.png", sizeBytes: "100", clientToken: "same" }],
    });
  await api.refresh(ID);
  expect(vi.mocked(call).mock.calls[0]).toEqual([
    "/m/files",
    {
      method: "POST",
      data: {
        category: "pay_receipt",
        files: [{ fileName: "receipt.pdf", sizeBytes: "100", clientToken: "same" }],
      },
    },
  ]);
  expect(vi.mocked(call).mock.calls.at(-1)).toEqual([
    `/m/files/${ID}/refresh-credentials`,
    { method: "POST" },
  ]);
});
