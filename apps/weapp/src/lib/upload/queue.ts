import { ApiError } from "../request";
import { clientToken } from "./hash";
import type { Registration, UploadApi, RegisterBody, FileStatus } from "./api";
import { MultipartUncertainError, type MultipartPort, type Recovery } from "./multipart";
import { ResumeRecordError } from "./resume";

export interface SelectedFile {
  path: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
}
export interface UploadContext {
  token: string | null;
  storeId: string | null;
  revision: number;
  scope?: string | null;
}
export interface UploadDeps {
  api: UploadApi;
  context(): UploadContext;
  head(path: string, length: number): Promise<Uint8Array>;
  post(
    ticket: Registration,
    file: SelectedFile,
    progress: (value: number) => void,
  ): { done: Promise<void>; abort(): void };
  now(): number;
  sleep(ms: number): Promise<void>;
  cancelSleep?(): void;
  key(action: string): string;
  multipart?: MultipartPort;
}
export interface UploadState {
  status:
    | "queued"
    | "uploading"
    | "confirming"
    | "storing"
    | "stored"
    | "failed"
    | "paused"
    | "cancelled";
  progress: number;
  fileId: string | null;
  message: string | null;
  canDelegate: boolean;
  recovery?: Recovery | null;
}
const cancelled = new Error("上传已停止");
/** 单文件串行用例。队列由调用方依次 start；凭证只在闭包内，不暴露给渲染/存储。 */
export function createUpload(
  deps: UploadDeps,
  file: SelectedFile,
  category: RegisterBody["category"],
  licenseKind?: RegisterBody["licenseKind"],
) {
  const owner = deps.context();
  let state: UploadState = {
    status: "queued",
    progress: 0,
    fileId: null,
    message: null,
    canDelegate: false,
  };
  let epoch = 0;
  let ticket: Registration | null = null;
  let token: string | null = null;
  let confirmKey = deps.key("file_complete");
  let uploaded = false;
  let promoting = false;
  let resumeChecked = false;
  let resumeFileId: string | null = null;
  let storedResult: FileStatus | null = null;
  let flight: Promise<FileStatus | null> | null = null;
  let transport: { abort(): void } | null = null;
  const listeners = new Set<() => void>();
  const same = () => {
    const c = deps.context();
    return (
      c.token === owner.token &&
      c.storeId === owner.storeId &&
      c.revision === owner.revision &&
      c.scope === owner.scope
    );
  };
  const update = (patch: Partial<UploadState>) => {
    state = { ...state, ...patch };
    for (const run of listeners) run();
  };
  const guard = (run: number) => {
    if (run !== epoch || !same()) throw cancelled;
  };
  const awaitCurrent = async <T>(promise: Promise<T>, run: number): Promise<T> => {
    const result = await promise;
    guard(run);
    return result;
  };
  const stop = () => {
    epoch++;
    deps.cancelSleep?.();
    transport?.abort();
    transport = null;
    ticket = null;
    update({ status: "cancelled", message: null });
  };
  const start = (): Promise<FileStatus | null> => {
    if (flight) return flight;
    if (state.status === "stored" && same()) return Promise.resolve(storedResult);
    if (state.status === "cancelled" || !same()) return Promise.resolve(null);
    const run = epoch;
    flight = (async () => {
      let resumeError: unknown = null;
      try {
        guard(run);
        update({ status: "uploading", message: null, canDelegate: false, recovery: null });
        if (!token)
          token = clientToken(
            {
              ...file,
              storeId: owner.storeId,
              category,
              durationMs: file.durationMs ?? 0,
              width: file.width ?? 0,
              height: file.height ?? 0,
            },
            await awaitCurrent(deps.head(file.path, Math.min(file.size, 256 * 1024)), run),
          );
        if (!resumeChecked && deps.multipart) {
          let restored: Awaited<ReturnType<MultipartPort["restore"]>> = null;
          try {
            restored = await awaitCurrent(
              deps.multipart.restore(token, file, () => guard(run)),
              run,
            );
          } catch (error) {
            guard(run);
            if (error instanceof ResumeRecordError) throw error;
            // 损坏 journal 禁止新的 MPU；它不阻断服务端明确选择的旧 POST 通道。
            resumeError = error;
          }
          if (restored) {
            resumeFileId = restored.fileId;
            confirmKey = restored.confirmKey;
            update({ fileId: restored.fileId });
            let remote = await awaitCurrent(deps.api.get(restored.fileId), run);
            while (remote.status === "promoting") {
              promoting = true;
              update({ status: "storing" });
              await awaitCurrent(deps.sleep(1000), run);
              remote = await awaitCurrent(deps.api.get(restored.fileId), run);
            }
            if (remote.status === "stored" && remote.moderationState !== "block") {
              deps.multipart.forget(restored.fileId);
              guard(run);
              storedResult = remote;
              update({ status: "stored", progress: 100 });
              return remote;
            }
            if (remote.status !== "pending")
              throw new Error("原上传已结束或审核未通过，请取消后重新选择");
            ticket = await awaitCurrent(deps.api.refresh(restored.fileId), run);
            if (ticket.fileId !== restored.fileId) throw new Error("续传凭据归属不一致");
          }
          resumeChecked = resumeError === null;
        }
        if (!ticket) {
          const response = await awaitCurrent(
            deps.api.register({
              category,
              ...(licenseKind ? { licenseKind } : {}),
              files: [{ fileName: file.name, sizeBytes: String(file.size), clientToken: token }],
            }),
            run,
          );
          ticket = response.items[0] ?? null;
          if (!ticket) throw new Error("没有取得上传凭证，请重试");
          update({ fileId: ticket.fileId });
        }
        if (ticket.mode === "multipart" && resumeError !== null) throw resumeError;
        if (ticket.mode !== "post" && !(ticket.mode === "multipart" && deps.multipart)) {
          update({
            status: "failed",
            message: "文件需要分块上传，请改传较小文件或联系服务经理代传",
            canDelegate: true,
          });
          return null;
        }
        let missed = 0;
        for (;;) {
          guard(run);
          if (!uploaded) {
            if (Date.parse(ticket.expiresAt) <= deps.now())
              ticket = await awaitCurrent(deps.api.refresh(ticket.fileId), run);
            if (ticket.mode !== "post" && !(ticket.mode === "multipart" && deps.multipart))
              throw new Error("上传通道不可用，请重试");
            update({ status: "uploading" });
            const progress = (progress: number) => {
              if (run === epoch && same()) update({ progress });
            };
            if (ticket.mode === "post" && !ticket.post) throw new Error("上传表单不可用，请重试");
            const task =
              ticket.mode === "multipart" && deps.multipart
                ? deps.multipart.upload(ticket, file, token, confirmKey, progress, () => guard(run))
                : deps.post(ticket, file, progress);
            transport = task;
            await awaitCurrent(task.done, run);
            transport = null;
            uploaded = true;
          }
          update({ status: "confirming", progress: 100 });
          let status: FileStatus;
          try {
            status = await awaitCurrent(deps.api.complete(ticket.fileId, confirmKey), run);
          } catch (error) {
            if (error instanceof ApiError && error.error === "CONFIRM_IN_PROGRESS") {
              await awaitCurrent(deps.sleep(1000), run);
              continue;
            }
            if (error instanceof ApiError && error.error === "UPLOAD_NOT_FOUND" && missed++ === 0) {
              if (ticket.mode === "multipart")
                throw new MultipartUncertainError("complete_unknown");
              uploaded = false;
              ticket = await awaitCurrent(deps.api.refresh(ticket.fileId), run);
              continue;
            }
            throw error;
          }
          while (status.status === "promoting") {
            promoting = true;
            update({ status: "storing" });
            await awaitCurrent(deps.sleep(1000), run);
            status = await awaitCurrent(deps.api.get(ticket.fileId), run);
          }
          if (status.status !== "stored" || status.moderationState === "block")
            throw new Error("文件未能入库或审核未通过，请重新选择");
          if (ticket.mode === "multipart") deps.multipart?.forget(ticket.fileId);
          guard(run);
          ticket = null;
          storedResult = status;
          update({ status: "stored" });
          return status;
        }
      } catch (error) {
        if (error === cancelled || !same() || run !== epoch) {
          if (run === epoch) stop();
          return null;
        }
        if (
          error instanceof ApiError &&
          ["UPLOAD_EXPIRED", "UPLOAD_REJECTED"].includes(error.error)
        ) {
          ticket = null;
          uploaded = false;
          promoting = false;
          confirmKey = deps.key("file_complete");
        }
        if (error instanceof ResumeRecordError) {
          resumeFileId = error.fileId;
          update({ fileId: error.fileId });
        }
        const details =
          error instanceof ApiError ? (error.details as { canDelegate?: boolean } | null) : null;
        update({
          status: "failed",
          message: error instanceof Error ? error.message : "上传失败，请重试",
          canDelegate: details?.canDelegate === true,
          recovery: error instanceof MultipartUncertainError ? error.recovery : null,
        });
        return null;
      } finally {
        transport = null;
        flight = null;
      }
    })();
    return flight;
  };
  return {
    snapshot: () => state,
    subscribe: (run: () => void) => {
      listeners.add(run);
      return () => {
        listeners.delete(run);
      };
    },
    start,
    retry: () => (state.status === "paused" && flight ? flight.then(start) : start()),
    pause() {
      if (["stored", "cancelled", "failed"].includes(state.status)) return;
      epoch++;
      deps.cancelSleep?.();
      transport?.abort();
      transport = null;
      update({ status: "paused", message: "上传已暂停，回到前台后继续" });
    },
    async cancel() {
      const pending = !promoting && same() ? (ticket?.fileId ?? resumeFileId) : null;
      const multipart = ticket?.mode === "multipart" || resumeFileId !== null;
      stop();
      if (pending) {
        await deps.api.cancel(pending, deps.key("file_cancel"));
        if (multipart && same()) deps.multipart?.forget(pending);
      }
    },
    dispose: stop,
  };
}
export type UploadJob = ReturnType<typeof createUpload>;

export function createUploadQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    add<T>(task: () => Promise<T>): Promise<T> {
      const work = tail.then(task);
      tail = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
  };
}

/** 暂停不结束页面的顺序队列；恢复后把真实入库结果交回原调用方。 */
export async function awaitUpload(job: UploadJob, retry = false): Promise<FileStatus | null> {
  const result = await (retry ? job.retry() : job.start());
  if (result) return result;
  if (["paused", "uploading", "confirming", "storing"].includes(job.snapshot().status)) {
    await new Promise<void>((resolve) => {
      const remove = job.subscribe(() => {
        if (["stored", "failed", "cancelled"].includes(job.snapshot().status)) {
          remove();
          resolve();
        }
      });
    });
  }
  return job.snapshot().status === "stored" ? job.start() : null;
}
