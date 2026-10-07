import { maxUploadBytes } from "@liyoxi/shared/uploads";
import type { UploadFn, UploadRule } from "../../../lib/upload";
import { newIdempotencyKey } from "../../../lib/idempotency";
import type { DetailApi, FileBody } from "./api";

export const productionUploadRule: UploadRule = {
  accept: [".mp4", ".mov"],
  maxSizeMb: Number(maxUploadBytes("sample_video", "mp4", "admin")) / 1024 / 1024,
};
type Registration = Awaited<ReturnType<DetailApi["file"]>>;
const canceled = () => new DOMException("上传已取消", "AbortError");
function delay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = window.setTimeout(finish, 1000);
    const abort = () => {
      window.clearTimeout(timer);
      reject(canceled());
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
export function postFile(
  registration: Registration,
  file: File,
  signal: AbortSignal,
  progress: (value: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(canceled());
      return;
    }
    if (registration.mode !== "post" || !registration.post) {
      reject(new Error("上传凭证不可用，请重新选择文件"));
      return;
    }
    const xhr = new XMLHttpRequest(),
      form = new FormData();
    for (const [key, value] of Object.entries(registration.post.fields)) form.append(key, value);
    form.append("file", file);
    const abort = () => xhr.abort();
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress((e.loaded / e.total) * 85);
    };
    xhr.onload = () =>
      finish(xhr.status >= 200 && xhr.status < 300 ? undefined : new Error("文件直传失败，请重试"));
    xhr.onerror = () => finish(new Error("文件直传网络失败，请重试"));
    xhr.onabort = () => finish(canceled());
    xhr.open("POST", registration.post.url);
    // 凭证表单独立直传：不发送后台 Cookie，不覆盖 multipart Content-Type。
    xhr.withCredentials = false;
    xhr.send(form);
  });
}

/** 一个上传位持有自己的意图和取消句柄；重试复用同一文件的 clientToken。 */
export function createProductionUpload(
  api: Pick<DetailApi, "file" | "complete" | "fileStatus">,
  context: Omit<FileBody, "fileName" | "sizeBytes" | "clientToken" | "mime">,
) {
  const entries = new WeakMap<
    File,
    { token: string; completeKey: string; registration?: Registration; posted: boolean }
  >();
  let current: AbortController | undefined,
    disposed = false;
  const upload: UploadFn = async (file, { onProgress }) => {
    if (disposed) throw canceled();
    current?.abort();
    const controller = new AbortController();
    current = controller;
    const signal = controller.signal;
    let entry = entries.get(file);
    if (!entry) {
      entry = {
        token: crypto.randomUUID(),
        completeKey: newIdempotencyKey("production-upload"),
        posted: false,
      };
      entries.set(file, entry);
    }
    const registration =
      entry.registration ??
      (await api.file(
        { ...context, fileName: file.name, sizeBytes: String(file.size), clientToken: entry.token },
        entry.token,
        signal,
      ));
    entry.registration = registration;
    if (signal.aborted || disposed) throw canceled();
    if (!entry.posted) {
      await postFile(registration, file, signal, onProgress);
      entry.posted = true;
    }
    onProgress(90);
    let status = await api.complete(registration.fileId, entry.completeKey, signal);
    for (let count = 0; status.status === "pending" || status.status === "promoting"; count++) {
      if (count >= 120) throw new Error("文件仍在入库，请稍后重试");
      await delay(signal);
      status = await api.fileStatus(registration.fileId, signal);
    }
    if (status.status !== "stored") throw new Error("文件入库失败，请重新选择文件");
    if (signal.aborted || disposed) throw canceled();
    onProgress(100);
    return { fileId: registration.fileId };
  };
  return {
    upload,
    dispose() {
      disposed = true;
      current?.abort();
    },
  };
}
