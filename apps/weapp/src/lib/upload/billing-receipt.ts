import type { SelectedFile, UploadJob } from "./queue";
export type ReceiptFile = SelectedFile;
export type ReceiptUploadState = {
  status: "idle" | "uploading" | "failed" | "done";
  progress: number;
  fileId: string | null;
  error: string | null;
};
/** 只转换凭证组件的展示状态；登记、直传、重试、确认与取消均使用统一上传用例。 */
export function createReceiptUpload(
  job: Pick<UploadJob, "snapshot" | "subscribe" | "start" | "retry" | "cancel" | "dispose">,
) {
  return {
    start: job.start,
    retry: job.retry,
    cancel: job.cancel,
    dispose: job.dispose,
    subscribe: job.subscribe,
    snapshot(): ReceiptUploadState {
      const state = job.snapshot();
      return {
        status:
          state.status === "stored"
            ? "done"
            : state.status === "failed" || state.status === "cancelled"
              ? "failed"
              : state.status === "queued"
                ? "idle"
                : "uploading",
        progress: state.progress,
        fileId: state.status === "stored" ? state.fileId : null,
        error: state.message,
      };
    },
  };
}
export type ReceiptUpload = ReturnType<typeof createReceiptUpload>;
