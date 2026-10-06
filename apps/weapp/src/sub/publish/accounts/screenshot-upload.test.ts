import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus, Registration } from "@/lib/upload/api";
import { createTaroUpload } from "@/lib/upload/taro";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { createScreenshotUpload } from "./screenshot-upload";

const boundary = vi.hoisted(() => ({
  request: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("@/lib/runtime", () => ({
  request: boundary.request,
  newIdempotencyKey: (action: string) => `${action}:test`,
}));
vi.mock("@tarojs/taro", () => ({
  default: {
    getFileSystemManager: () => ({
      readFile: ({ success }: { success(result: { data: ArrayBuffer }): void }) =>
        success({ data: new Uint8Array([1, 2, 3]).buffer }),
    }),
    uploadFile: boundary.upload,
    setKeepScreenOn: async () => {},
  },
}));
const ID = "00000000-0000-4000-8000-000000000001";
const SECOND = "00000000-0000-4000-8000-000000000002";
const status = (fileId = ID): FileStatus => ({
  fileId,
  category: "channel_screenshot",
  status: "stored",
  rejectReason: null,
  declaredSizeBytes: "100",
  sizeBytes: "100",
  mime: "image/png",
  moderationState: "pass",
  storedAt: null,
  uploadExpiresAt: null,
  createdAt: "2026-01-01T00:00:00Z",
});
const ticket = (fileId: string, clientToken: string): Registration => ({
  fileId,
  clientToken,
  status: "pending",
  mode: "post",
  bucket: "incoming",
  region: "local",
  key: `incoming/${fileId}`,
  post: { url: "http://storage.invalid", fields: { key: `incoming/${fileId}` } },
  sts: null,
  chunkSize: null,
  chunkParallel: null,
  expiresAt: "2030-01-01T00:00:00Z",
  uploadExpiresAt: "2030-01-02T00:00:00Z",
  credentialsLeft: 30,
});
beforeEach(() => {
  boundary.request.mockReset();
  boundary.upload.mockReset();
  useSessionStore.getState().setSession("fixture-owner");
  useContextStore.getState().switchStore(ID);
});
describe("账号截图完成边界", () => {
  it("真实公共队列：首张失败、第二张占用队列，连续重试只交付一次", async () => {
    let finishSecond!: () => void;
    let firstAttempts = 0;
    boundary.request.mockImplementation(async (path, options) => {
      if (path === "/m/files") {
        const file = options.data.files[0];
        return { items: [ticket(file.fileName === "first.png" ? ID : SECOND, file.clientToken)] };
      }
      return status(path.includes(SECOND) ? SECOND : ID);
    });
    boundary.upload.mockImplementation(({ filePath, success, fail }) => {
      if (filePath === "second.png") finishSecond = () => success({ statusCode: 200 });
      else if (++firstAttempts === 1) queueMicrotask(() => fail(new Error("断网")));
      else queueMicrotask(() => success({ statusCode: 200 }));
      return { onProgressUpdate() {}, abort() {} };
    });
    const first = createTaroUpload(
      { path: "first.png", name: "first.png", size: 100 },
      "channel_screenshot",
    );
    const second = createTaroUpload(
      { path: "second.png", name: "second.png", size: 100 },
      "channel_screenshot",
    );
    const delivered: string[] = [];
    const entry = createScreenshotUpload(
      first,
      () => () => true,
      (id) => delivered.push(id),
    );
    try {
      await entry.finish();
      expect(first.snapshot().status).toBe("failed");
      const occupied = second.start();
      await vi.waitFor(() => expect(finishSecond).toBeTypeOf("function"));
      const a = entry.finish(true);
      const b = entry.finish(true);
      expect(first.snapshot().status).toBe("failed");
      expect(delivered).toEqual([]);
      finishSecond();
      await Promise.all([occupied, a, b]);
      expect(firstAttempts).toBe(2);
      expect(delivered).toEqual([ID]);
      await entry.finish(true);
      expect(delivered).toEqual([ID]);
    } finally {
      first.dispose();
      second.dispose();
    }
  });
  it("移除后，即使已经在交付边界的结果晚到，也不会回填", async () => {
    let resolve!: (value: FileStatus) => void;
    const pending = new Promise<FileStatus>((done) => {
      resolve = done;
    });
    const job = {
      start: () => pending,
      retry: () => pending,
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const delivered = vi.fn();
    const entry = createScreenshotUpload(job, () => () => true, delivered);
    const completion = entry.finish();
    await entry.remove();
    resolve(status());
    await completion;
    expect(job.cancel).toHaveBeenCalledOnce();
    expect(delivered).not.toHaveBeenCalled();
    await entry.finish(true);
    expect(delivered).not.toHaveBeenCalled();
  });
  it("卸载或门店上下文失效后不交付", async () => {
    let active = true;
    let resolve!: (value: FileStatus) => void;
    const pending = new Promise<FileStatus>((done) => {
      resolve = done;
    });
    const delivered = vi.fn();
    const entry = createScreenshotUpload(
      { start: () => pending, retry: () => pending, cancel: async () => {}, dispose() {} },
      () => () => active,
      delivered,
    );
    const completion = entry.finish();
    active = false;
    resolve(status());
    await completion;
    expect(delivered).not.toHaveBeenCalled();
  });
});
