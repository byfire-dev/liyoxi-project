import { describe, expect, it, vi } from "vitest";
import type { Data } from "../account-api";
import type { RequestLayer } from "../request";
import { createReceiptUpload } from "./billing-receipt";
const id = "00000000-0000-4000-8000-000000000001",
  now = "2026-10-06T00:00:00Z";
const registration: Data<"m.file.create"> = {
  items: [
    {
      fileId: id,
      clientToken: "samefile",
      status: "pending",
      mode: "post",
      bucket: "secure",
      region: "ap-shanghai",
      key: "pending/receipt.png",
      post: { url: "https://fake-storage.invalid/upload", fields: { key: "pending/receipt.png" } },
      sts: null,
      chunkSize: null,
      chunkParallel: null,
      expiresAt: now,
      uploadExpiresAt: now,
      credentialsLeft: 30,
    },
  ],
};
const fileView = (status: string): Data<"m.file.get"> => ({
  fileId: id,
  category: "pay_receipt",
  status,
  rejectReason: null,
  declaredSizeBytes: "8",
  sizeBytes: status === "stored" ? "8" : null,
  mime: "image/png",
  moderationState: "not_required",
  storedAt: status === "stored" ? now : null,
  uploadExpiresAt: now,
  createdAt: now,
});
const file = { path: "/tmp/fake-receipt.png", name: "receipt.png", size: 8 };
const caller =
  (
    handler: (path: string, options?: Parameters<RequestLayer["request"]>[1]) => Promise<unknown>,
  ): RequestLayer["request"] =>
  async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]) =>
    (await handler(path, options)) as T;
describe("回单入库与取消", () => {
  it("HTTP直传成功和complete queued不算完成，直到GET stored才可引用", async () => {
    let release!: () => void,
      reads = 0;
    const wait = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const job = createReceiptUpload(file, {
      key: (action) => action,
      wait,
      upload: () => ({ promise: Promise.resolve(), abort: vi.fn() }),
      call: caller(async (path) =>
        path === "/m/files"
          ? registration
          : path.endsWith("complete")
            ? fileView("queued")
            : (++reads, fileView("stored")),
      ),
    });
    const running = job.start();
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    expect(job.snapshot()).toMatchObject({ status: "uploading", fileId: null });
    release();
    await running;
    expect(reads).toBe(1);
    expect(job.snapshot()).toMatchObject({ status: "done", fileId: id });
  });
  it("complete UPLOAD_NOT_FOUND重试再POST，同clientToken/登记/确认键不变", async () => {
    const calls: { path: string; key?: string }[] = [];
    let completes = 0;
    const upload = vi.fn(() => ({ promise: Promise.resolve(), abort: vi.fn() }));
    const job = createReceiptUpload(file, {
      key: (action) => action + "_key",
      upload,
      call: caller(async (path, options) => {
        calls.push({ path, key: options?.idempotencyKey });
        if (path === "/m/files") return registration;
        if (++completes === 1)
          throw Object.assign(new Error("未找到直传对象"), { error: "UPLOAD_NOT_FOUND" });
        return fileView("stored");
      }),
    });
    await job.start();
    expect(job.snapshot().status).toBe("failed");
    await job.retry();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(calls.filter((v) => v.path === "/m/files")).toHaveLength(1);
    expect(calls.filter((v) => v.path.endsWith("complete")).map((v) => v.key)).toEqual([
      "receipt-complete_key",
      "receipt-complete_key",
    ]);
    expect(job.snapshot().status).toBe("done");
  });
  it("取消上传abort当前请求，退出后既不确认也不轮询", async () => {
    let release!: () => void;
    const abort = vi.fn(),
      call = vi.fn(async (path) => (path === "/m/files" ? registration : fileView("stored")));
    const job = createReceiptUpload(file, {
      key: (action) => action,
      upload: () => ({
        promise: new Promise<void>((resolve) => {
          release = resolve;
        }),
        abort,
      }),
      call: caller(call),
    });
    const running = job.start();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    job.dispose();
    release();
    await running;
    expect(abort).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("处理等待时取消，不再发下一次GET；空登记响应可重试而非永久上传中", async () => {
    let release!: () => void;
    const call = vi.fn(async (path) => (path === "/m/files" ? registration : fileView("queued")));
    const job = createReceiptUpload(file, {
      key: (action) => action,
      wait: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      upload: () => ({ promise: Promise.resolve(), abort: vi.fn() }),
      call: caller(call),
    });
    const running = job.start();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    job.cancel();
    release();
    await running;
    expect(call).toHaveBeenCalledTimes(2);
    const missing = createReceiptUpload(file, {
      key: (action) => action,
      call: caller(async () => ({ items: [] })),
      upload: vi.fn(),
    });
    await missing.start();
    expect(missing.snapshot().status).toBe("failed");
  });
});
