import { localStorageRequestUrl } from "../../../lib/local-storage";
import { FileRegistrationSchema } from "@liyoxi/contract";
import { maxUploadBytes } from "@liyoxi/shared/uploads";
import type { UploadFn, UploadRule } from "../../../lib/upload";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { createMultipartUploadAdapter } from "../../../lib/upload-multipart";
import type { DetailApi, FileBody } from "./api";

export const productionUploadRule: UploadRule = {
  accept: [".mp4", ".mov"],
  maxSizeMb: Number(maxUploadBytes("sample_video", "mp4", "admin")) / 1024 / 1024,
};
type Registration = Awaited<ReturnType<DetailApi["file"]>>;
function multipartStatus(value: Awaited<ReturnType<DetailApi["fileStatus"]>>) {
  if (typeof value.status !== "string") throw new Error("上传状态不合格");
  return { fileId: value.fileId, status: value.status };
}
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
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress((e.loaded / e.total) * 85);
    };
    xhr.onload = () =>
      finish(
        xhr.status >= 200 && xhr.status < 300
          ? undefined
          : new Error(`文件直传失败（HTTP ${xhr.status}），请重试`),
      );
    xhr.onerror = () => finish(new Error("文件直传网络失败，请重试"));
    xhr.timeout = 120_000;
    xhr.ontimeout = () => finish(new Error("文件直传超时，请检查网络后重试"));
    xhr.onabort = () => finish(canceled());
    xhr.open("POST", localStorageRequestUrl(registration.post.url, __LYX_LOCAL_STORAGE_ORIGIN__));
    // 凭证表单独立直传：不发送后台 Cookie，不覆盖 multipart Content-Type。
    xhr.withCredentials = false;
    xhr.send(form);
  });
}

/** 一个上传位持有自己的意图和取消句柄；重试复用同一文件的 clientToken。 */
export function createProductionUpload(
  api: Pick<DetailApi, "file" | "complete" | "fileStatus" | "refreshCredentials">,
  context: Omit<FileBody, "fileName" | "sizeBytes" | "clientToken" | "mime">,
) {
  const entries = new WeakMap<
    File,
    {
      token: string;
      completeKey: string;
      registration?: Registration;
      posted: boolean;
      signal: AbortSignal;
      multipart?: ReturnType<typeof createMultipartUploadAdapter>;
    }
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
        signal,
      };
      entries.set(file, entry);
    }
    const owned = entry;
    owned.signal = signal;
    const abortMultipart = () => {
      if (!owned.multipart) return;
      owned.multipart.close();
      // A cancelled selection starts a new intent if selected again; network retries keep the session.
      if (entries.get(file) === owned) entries.delete(file);
    };
    signal.addEventListener("abort", abortMultipart, { once: true });
    try {
      let registration =
        entry.registration ??
        (await api.file(
          {
            ...context,
            fileName: file.name,
            sizeBytes: String(file.size),
            clientToken: entry.token,
          },
          entry.token,
          signal,
        ));
      entry.registration = registration;
      if (signal.aborted || disposed) throw canceled();
      if (!entry.posted) {
        if (Date.parse(registration.uploadExpiresAt) <= Date.now()) {
          throw new Error("本次上传已过期，请重新选择文件");
        }
        if (registration.mode === "multipart") {
          owned.multipart ??= createMultipartUploadAdapter({
            ports: {
              register: async () => FileRegistrationSchema.parse(owned.registration),
              refresh: async (fileId) => {
                if (Date.parse(owned.registration!.uploadExpiresAt) <= Date.now())
                  throw new Error("本次上传已过期，请重新选择文件");
                return FileRegistrationSchema.parse(
                  await api.refreshCredentials(fileId, owned.signal),
                );
              },
              complete: async (fileId) => {
                const requestSignal = owned.signal;
                let status = await api.complete(fileId, owned.completeKey, requestSignal);
                // Preserve the single-file endpoint's pending state as well as promoting.
                for (
                  let count = 0;
                  status.status === "pending" || status.status === "promoting";
                  count++
                ) {
                  if (count >= 120) throw new Error("文件仍在入库，请稍后重试");
                  await delay(requestSignal);
                  status = await api.fileStatus(fileId, requestSignal);
                }
                return multipartStatus(status);
              },
              get: async (fileId) => multipartStatus(await api.fileStatus(fileId, owned.signal)),
              // This slot exposes dispose(), which aborts local work without deleting server facts.
              cancel: async () => {
                throw canceled();
              },
            },
          });
          const result = await owned.multipart.upload(file, {
            onProgress: (value) => {
              if (!signal.aborted && !disposed) onProgress(value);
            },
          });
          owned.posted = true;
          return result;
        }
        if (Date.parse(registration.expiresAt) <= Date.now() + 30_000) {
          registration = await api.refreshCredentials(registration.fileId, signal);
          entry.registration = registration;
          if (signal.aborted || disposed) throw canceled();
          if (Date.parse(registration.expiresAt) <= Date.now()) {
            throw new Error("上传凭证已过期，请重试");
          }
        }
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
    } catch (error) {
      if (signal.aborted || disposed) throw canceled();
      throw error;
    } finally {
      signal.removeEventListener("abort", abortMultipart);
      if (current === controller) current = undefined;
    }
  };
  return {
    upload,
    dispose() {
      disposed = true;
      current?.abort();
    },
  };
}
