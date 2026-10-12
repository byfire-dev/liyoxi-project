import Taro from "@tarojs/taro";
import { useSyncExternalStore } from "react";
import { newIdempotencyKey, request } from "../runtime";
import { useContextStore } from "../../stores/context";
import { useSessionStore } from "../../stores/session";
import { useBootstrapStore } from "../../stores/bootstrap";
import { createUploadApi, type RegisterBody } from "./api";
import { awaitUpload, createUpload, createUploadQueue, type SelectedFile } from "./queue";
import { precheckFile } from "./precheck";
import { account } from "../account-runtime";
import { storage } from "../platform.taro";
import { createMultipartPort, type CloudRequest, type CloudTask } from "./multipart";
import { createResumeStore, type ResumeOwner } from "./resume";
const resumeStore = createResumeStore(storage, Date.now);
function uploadOwner(): ResumeOwner | null {
  const me = account.snapshot().me;
  const storeId = useContextStore.getState().currentStoreId;
  const member = me?.memberships.find((item) => item.stores.some((s) => s.storeId === storeId));
  if (!me || !member || !storeId || !useSessionStore.getState().accessToken) return null;
  return {
    userId: me.user.merchantUserId,
    memberId: member.memberId,
    entityId: member.entity.entityId,
    storeId,
    role: member.role,
    storeScope: JSON.stringify(member.stores.map((s) => [s.storeId, s.lifecycle]).sort()),
  };
}
useSessionStore.subscribe((state, previous) => {
  if (previous.accessToken && state.accessToken !== previous.accessToken) {
    try {
      resumeStore.clear();
    } catch {
      /* 清除失败的残留仍由完整 owner 隔离，不作为别人的恢复入口。 */
    }
  }
});

/** 微信读取原始范围；请求不经业务 HTTP，不携带商家令牌。 */
export function createTaroMultipartPorts() {
  return {
    read(path: string, offset: number, length: number): Promise<Uint8Array> {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length <= 0
      )
        return Promise.reject(new Error("文件读取范围不合格"));
      return new Promise((resolve, reject) => {
        Taro.getFileSystemManager().readFile({
          filePath: path,
          position: offset,
          length,
          success: ({ data }) => {
            if (typeof data === "string" || data.byteLength !== length)
              reject(new Error("文件读取不完整，请重新选择"));
            else resolve(new Uint8Array(data));
          },
          fail: () => reject(new Error("文件已不可读，请重新选择同一文件以续传")),
        });
      });
    },
    send(input: CloudRequest): CloudTask {
      const task = Taro.request<string, string | ArrayBuffer>({
        url: input.url,
        method: input.method,
        header: input.headers,
        data: input.data,
        dataType: "text",
        responseType: "text",
        timeout: 300000,
      });
      const done = task.then((response) => {
        if (typeof response.data !== "string") throw new Error("对象存储响应格式不合格");
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.header ?? {})) {
          if (typeof value !== "string") throw new Error("对象存储响应头不合格");
          headers[key] = value;
        }
        return { statusCode: response.statusCode, headers, data: response.data };
      });
      return { done, abort: () => task.abort() };
    },
  };
}
const activeUploads = new Set<object>();
const uploadQueue = createUploadQueue();
const busyUploads = new Set<object>();
const busyListeners = new Set<() => void>();
export function useUploadBusy(): boolean {
  return useSyncExternalStore(
    (listener) => {
      busyListeners.add(listener);
      return () => {
        busyListeners.delete(listener);
      };
    },
    () => busyUploads.size > 0,
    () => false,
  );
}

/** Taro 仅在此边界出现；业务 HTTP 沿中央请求，对象存储只收到指定表单。 */
export function createTaroUpload(
  file: SelectedFile,
  category: RegisterBody["category"],
  licenseKind?: RegisterBody["licenseKind"],
) {
  let cancelSleep = () => {};
  const api = createUploadApi(request);
  const native = createTaroMultipartPorts();
  const job = createUpload(
    {
      api,
      context: () => ({
        token: useSessionStore.getState().accessToken,
        storeId: useContextStore.getState().currentStoreId,
        revision: useContextStore.getState().contextRev,
        scope: JSON.stringify(uploadOwner()),
      }),
      head: (path, length) =>
        new Promise((resolve, reject) => {
          Taro.getFileSystemManager().readFile({
            filePath: path,
            position: 0,
            length,
            success: ({ data }) => {
              if (typeof data === "string") reject(new Error("文件读取失败，请重新选择"));
              else resolve(new Uint8Array(data));
            },
            fail: reject,
          });
        }),
      post: (ticket, selected, progress) => {
        let task: Taro.UploadTask;
        const done = new Promise<void>((resolve, reject) => {
          task = Taro.uploadFile({
            url: ticket.post!.url,
            filePath: selected.path,
            name: "file",
            formData: ticket.post!.fields,
            success: (response) => {
              if (response.statusCode >= 200 && response.statusCode < 300) resolve();
              else reject(new Error("直传失败，请重试"));
            },
            fail: () => reject(new Error("直传失败，请重试")),
          });
          task.onProgressUpdate((event) => progress(event.progress));
        });
        return { done, abort: () => task?.abort() };
      },
      now: Date.now,
      sleep: (ms) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            cancelSleep = () => {};
            resolve();
          }, ms);
          cancelSleep = () => {
            clearTimeout(timer);
            cancelSleep = () => {};
            resolve();
          };
        }),
      cancelSleep: () => cancelSleep(),
      key: newIdempotencyKey,
      ...(process.env.TARO_ENV === "weapp"
        ? {
            multipart: createMultipartPort({
              ...native,
              owner: uploadOwner,
              resume: resumeStore,
              refresh: api.refresh,
              now: Date.now,
            }),
          }
        : {}),
    },
    file,
    category,
    licenseKind,
  );
  const removeContext = useContextStore.subscribe((state, previous) => {
    if (state.contextRev !== previous.contextRev) job.dispose();
  });
  const removeSession = useSessionStore.subscribe((state, previous) => {
    if (state.accessToken !== previous.accessToken) job.dispose();
  });
  let ownerScope = JSON.stringify(uploadOwner());
  const removeAccount = account.subscribe(() => {
    const current = JSON.stringify(uploadOwner());
    if (current !== ownerScope) {
      ownerScope = current;
      job.dispose();
    }
  });
  const removeState = job.subscribe(() => {
    if (["uploading", "confirming", "storing", "paused"].includes(job.snapshot().status))
      busyUploads.add(job);
    else busyUploads.delete(job);
    for (const listener of busyListeners) listener();
    if (["uploading", "confirming", "storing"].includes(job.snapshot().status))
      activeUploads.add(job);
    else activeUploads.delete(job);
    void Taro.setKeepScreenOn({ keepScreenOn: activeUploads.size > 0 }).catch(() => undefined);
  });
  const hide = () => job.pause();
  const show = () => {
    if (job.snapshot().status === "paused") void job.retry();
  };
  Taro.onAppHide?.(hide);
  Taro.onAppShow?.(show);
  const remove = () => {
    removeContext();
    removeSession();
    removeAccount();
    Taro.offAppHide?.(hide);
    Taro.offAppShow?.(show);
  };
  const dispose = () => {
    remove();
    job.dispose();
    removeState();
  };
  let work: ReturnType<typeof awaitUpload> | null = null;
  const start = (retry = false) => {
    if (work) {
      if (job.snapshot().status === "paused") void job.retry();
      return work;
    }
    work = uploadQueue.add(() => awaitUpload(job, retry));
    void work.then(
      () => {
        work = null;
      },
      () => {
        work = null;
      },
    );
    return work;
  };
  return {
    ...job,
    start: () => start(),
    retry: () => start(true),
    dispose,
    async cancel() {
      remove();
      try {
        await job.cancel();
      } finally {
        removeState();
      }
    },
  };
}

export function prepareTaroFile(file: SelectedFile, category: RegisterBody["category"]) {
  return precheckFile(
    {
      compress: async (original, quality) => {
        const compressed = await Taro.compressImage({ src: original.path, quality });
        const [info, bytes] = await Promise.all([
          Taro.getImageInfo({ src: compressed.tempFilePath }),
          Taro.getFileInfo({ filePath: compressed.tempFilePath }),
        ]);
        return {
          ...original,
          path: compressed.tempFilePath,
          name: `upload.${info.type}`,
          size: "size" in bytes ? bytes.size : 0,
          width: info.width,
          height: info.height,
        };
      },
      compressVideo: async (original) => {
        const compressed = await Taro.compressVideo({
          src: original.path,
          quality: "low",
          bitrate: 1000,
          fps: 24,
          resolution: 1,
        });
        const [info, bytes] = await Promise.all([
          Taro.getVideoInfo({ src: compressed.tempFilePath }),
          Taro.getFileInfo({ filePath: compressed.tempFilePath }),
        ]);
        return {
          ...original,
          path: compressed.tempFilePath,
          name: "upload.mp4",
          size: "size" in bytes ? bytes.size : 0,
          width: info.width,
          height: info.height,
          durationMs: Math.round(info.duration * 1000),
        };
      },
      network: async () => (await Taro.getNetworkType()).networkType,
      confirmCellular: async (sizeMb) =>
        (
          await Taro.showModal({
            title: "使用移动网络上传",
            content: `文件约${sizeMb}MB，将消耗移动流量。继续上传？`,
          })
        ).confirm,
    },
    file,
    category,
    useBootstrapStore.getState().data.uploadLimits,
  );
}
