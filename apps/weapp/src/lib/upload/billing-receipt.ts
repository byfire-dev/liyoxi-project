import type { Data } from "../account-api";
import type { RequestLayer } from "../request";
export interface ReceiptFile {
  path: string;
  name: string;
  size: number;
}
export type ReceiptUploadState = {
  status: "idle" | "uploading" | "failed" | "done";
  progress: number;
  fileId: string | null;
  error: string | null;
};
export interface ReceiptUploadDeps {
  call: RequestLayer["request"];
  key(action: string): string;
  upload(
    post: NonNullable<Data<"m.file.create">["items"][number]["post"]>,
    file: ReceiptFile,
    progress: (value: number) => void,
  ): { promise: Promise<void>; abort(): void };
  wait?: (ms: number) => Promise<void>;
}
/** W1-12 最小 post 图凭证：同一次选择沿用 clientToken/登记/确认键，stored 才可提交业务引用。 */
export function createReceiptUpload(file: ReceiptFile, deps: ReceiptUploadDeps) {
  const registerKey = deps.key("receipt-register"),
    completeKey = deps.key("receipt-complete"),
    clientToken = deps.key("receiptfile").replaceAll(":", "_");
  const listeners = new Set<() => void>();
  let state: ReceiptUploadState = { status: "idle", progress: 0, fileId: null, error: null };
  let registration: Data<"m.file.create">["items"][number] | null = null;
  let sent = false,
    running = false,
    disposed = false,
    cancelled = false;
  let abort: (() => void) | null = null;
  const publish = (next: ReceiptUploadState) => {
    if (!disposed && !cancelled) {
      state = next;
      listeners.forEach((v) => v());
    }
  };
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  async function start() {
    if (running || disposed || cancelled || state.status === "done") return;
    running = true;
    publish({ ...state, status: "uploading", error: null });
    try {
      if (!registration) {
        const result = await deps.call<Data<"m.file.create">>("/m/files", {
          method: "POST",
          idempotencyKey: registerKey,
          data: {
            category: "pay_receipt",
            files: [{ fileName: file.name, sizeBytes: String(file.size), clientToken }],
          },
        });
        registration = result.items[0] ?? null;
      }
      if (disposed || cancelled) return;
      if (!registration) throw new Error("未取得图片上传凭证，请重试");
      if (registration.status === "stored") {
        publish({ status: "done", progress: 100, fileId: registration.fileId, error: null });
        return;
      }
      if (registration.mode !== "post" || !registration.post)
        throw new Error("请换用更小的凭证图片，或联系服务经理代传");
      if (!sent) {
        const task = deps.upload(registration.post, file, (progress) =>
          publish({ ...state, progress }),
        );
        abort = task.abort;
        await task.promise;
        abort = null;
        sent = true;
      }
      if (disposed || cancelled) return;
      let view = await deps.call<Data<"m.file.complete">>(
        `/m/files/${registration.fileId}/complete`,
        { method: "POST", data: {}, idempotencyKey: completeKey },
      );
      for (let attempt = 0; view.status !== "stored" && attempt < 30; attempt++) {
        if (disposed || cancelled) return;
        if (view.status === "rejected" || view.status === "failed" || view.status === "deleted")
          throw new Error("凭证图片处理未通过，请重新选择");
        await wait(1000);
        if (disposed || cancelled) return;
        view = await deps.call<Data<"m.file.get">>(`/m/files/${registration.fileId}`);
      }
      if (view.status !== "stored") throw new Error("凭证仍在处理中，请稍后重试");
      publish({ status: "done", progress: 100, fileId: registration.fileId, error: null });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "error" in error &&
        error.error === "UPLOAD_NOT_FOUND"
      )
        sent = false;
      publish({
        ...state,
        status: "failed",
        error: error instanceof Error ? error.message : "上传失败，请重试",
      });
    } finally {
      running = false;
    }
  }
  return {
    start,
    retry: start,
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel() {
      cancelled = true;
      abort?.();
    },
    dispose() {
      disposed = true;
      abort?.();
      listeners.clear();
    },
  };
}
export type ReceiptUpload = ReturnType<typeof createReceiptUpload>;
