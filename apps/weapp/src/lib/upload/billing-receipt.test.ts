import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestLayer } from "../request";
import { ApiError } from "../request";
import { createUploadApi, type FileStatus, type Registration } from "./api";
import { createUpload, type UploadContext, type UploadDeps } from "./queue";
import { createReceiptUpload } from "./billing-receipt";
import {
  billingReceipt,
  billingReceiptDeps,
  billingUploadEvidence,
  offlineBillingRequest,
} from "../../../shots/billing-fixtures";
const id = "00000000-0000-4000-8000-000000000001";
const ticket: Registration = {
  fileId: id,
  clientToken: "samefile",
  status: "pending",
  mode: "post",
  bucket: "secure",
  region: "local",
  key: "receipt",
  post: { url: "https://fake-storage.invalid/upload", fields: { key: "receipt" } },
  sts: null,
  chunkSize: null,
  chunkParallel: null,
  expiresAt: "2030-01-01T00:00:00Z",
  uploadExpiresAt: "2030-01-02T00:00:00Z",
  credentialsLeft: 30,
};
const status = (value: string): FileStatus => ({
  fileId: id,
  category: "pay_receipt",
  status: value,
  rejectReason: null,
  declaredSizeBytes: "8",
  sizeBytes: value === "stored" ? "8" : null,
  mime: "application/pdf",
  moderationState: "not_required",
  storedAt: null,
  uploadExpiresAt: null,
  createdAt: "2026-10-06T00:00:00Z",
});
function harness(name = "receipt.png") {
  let context: UploadContext = { token: "owner", storeId: id, revision: 1 };
  const calls: { path: string; key?: string; data?: unknown }[] = [];
  const handler = vi.fn(async (path: string) =>
    path === "/m/files"
      ? { items: [ticket] }
      : path.endsWith("refresh-credentials")
        ? ticket
        : path.endsWith("complete")
          ? status("promoting")
          : status("stored"),
  );
  const call: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ) => {
    calls.push({ path, key: options?.idempotencyKey, data: options?.data });
    return (await handler(path)) as T;
  };
  const deps: UploadDeps = {
    api: createUploadApi(call),
    context: () => context,
    key: (action) => action + "_key",
    head: vi.fn(async () => new Uint8Array([1, 2, 3])),
    post: vi.fn(() => ({ done: Promise.resolve(), abort: vi.fn() })),
    now: () => 0,
    sleep: vi.fn(async () => {}),
  };
  const file = { path: "local-receipt", name, size: 8 };
  const job = createReceiptUpload(createUpload(deps, file, "pay_receipt"));
  return {
    job,
    deps,
    handler,
    calls,
    change: () => {
      context = { ...context, revision: context.revision + 1 };
    },
  };
}
beforeEach(() => {
  billingUploadEvidence.length = 0;
});
describe("回单复用统一上传用例", () => {
  it.each(["receipt.png", "receipt.pdf"])(
    "%s沿统一登记与确认，promoting期间不能作为已入库引用",
    async (name) => {
      const h = harness(name);
      let release!: () => void;
      h.deps.sleep = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const work = h.job.start();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(h.job.snapshot()).toMatchObject({ status: "uploading", fileId: null });
      release();
      await work;
      expect(h.calls.map((v) => v.path)).toEqual([
        "/m/files",
        `/m/files/${id}/complete`,
        `/m/files/${id}`,
      ]);
      expect(h.calls[0]!.data).toMatchObject({
        category: "pay_receipt",
        files: [
          { fileName: name, sizeBytes: "8", clientToken: expect.stringMatching(/^[0-9a-f]{40}$/) },
        ],
      });
      expect(h.job.snapshot()).toMatchObject({ status: "done", fileId: id });
      // 对象直传只接凭证/文件/进度回调，不包含任何业务鉴权或幂等header。
      expect(h.deps.post).toHaveBeenCalledWith(
        ticket,
        expect.objectContaining({ name }),
        expect.any(Function),
      );
    },
  );
  it("直传网络失败后重试不重复登记/hash，保持同clientToken与确认键", async () => {
    const h = harness();
    let attempt = 0;
    h.deps.post = vi.fn(() => ({
      done: ++attempt === 1 ? Promise.reject(new Error("网络中断")) : Promise.resolve(),
      abort: vi.fn(),
    }));
    await h.job.start();
    expect(h.job.snapshot().status).toBe("failed");
    await h.job.retry();
    expect(h.deps.head).toHaveBeenCalledOnce();
    expect(h.calls.filter((v) => v.path === "/m/files")).toHaveLength(1);
    expect(h.calls.find((v) => v.path.endsWith("complete"))?.key).toBe("file_complete_key");
    expect(h.job.snapshot().status).toBe("done");
  });
  it("UPLOAD_NOT_FOUND经统一refresh再直传，完成键不换、不重新登记", async () => {
    const h = harness();
    let complete = 0;
    h.handler.mockImplementation(async (path) => {
      if (path === "/m/files") return { items: [ticket] };
      if (path.endsWith("refresh-credentials")) return ticket;
      if (path.endsWith("complete") && ++complete === 1)
        throw new ApiError({
          error: "UPLOAD_NOT_FOUND",
          status: 409,
          requestId: "test",
          message: "对象未到",
        });
      return status("stored");
    });
    await h.job.start();
    expect(h.deps.post).toHaveBeenCalledTimes(2);
    expect(h.calls.filter((v) => v.path === "/m/files")).toHaveLength(1);
    expect(h.calls.filter((v) => v.path.endsWith("complete")).map((v) => v.key)).toEqual([
      "file_complete_key",
      "file_complete_key",
    ]);
    expect(h.job.snapshot().status).toBe("done");
  });
  it.each(["dispose", "context"])("%s之后直传迟到，不确认/轮询或暴露可用fileId", async (action) => {
    const h = harness();
    let release!: () => void;
    const abort = vi.fn();
    h.deps.post = vi.fn(() => ({
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
      abort,
    }));
    const work = h.job.start();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    if (action === "dispose") h.job.dispose();
    else h.change();
    release();
    await work;
    if (action === "dispose") expect(abort).toHaveBeenCalledOnce();
    expect(h.calls).toHaveLength(1);
    expect(h.job.snapshot().fileId).toBeNull();
  });
  it("取消委托统一引擎abort并调用cancel，不确认迟到的直传", async () => {
    const h = harness();
    let release!: () => void;
    const abort = vi.fn();
    h.deps.post = vi.fn(() => ({
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
      abort,
    }));
    const work = h.job.start();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await h.job.cancel();
    release();
    await work;
    expect(abort).toHaveBeenCalledOnce();
    expect(h.calls.map((call) => call.path)).toEqual(["/m/files", `/m/files/${id}/cancel`]);
    expect(h.job.snapshot().fileId).toBeNull();
  });
  it("空登记响应失败后可以沿同文件意图重试", async () => {
    const h = harness();
    h.handler.mockResolvedValueOnce({ items: [] });
    await h.job.start();
    expect(h.job.snapshot().status).toBe("failed");
    await h.job.retry();
    const bodies = h.calls.filter((call) => call.path === "/m/files").map((call) => call.data);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(h.job.snapshot().status).toBe("done");
  });
  it("本域H5仅替代原生依赖，实际统一引擎完成head→register→post→complete→get", async () => {
    const job = createReceiptUpload(
      createUpload(
        billingReceiptDeps(
          offlineBillingRequest("bank-selected"),
          (action) => `${action}_key`,
          () => ({ token: "owner", storeId: id, revision: 1 }),
        ),
        billingReceipt,
        "pay_receipt",
      ),
    );
    await job.start();
    expect(billingUploadEvidence).toEqual(["head", "register", "post", "complete", "get"]);
    expect(job.snapshot()).toMatchObject({ status: "done", fileId: id });
  });
});
