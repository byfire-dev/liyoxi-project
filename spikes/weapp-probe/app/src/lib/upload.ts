import Taro from "@tarojs/taro";
import COS from "cos-wx-sdk-v5";
import type { CosClient } from "cos-wx-sdk-v5";
import { api, ensurePrivacy, errorCode, isFake, newId, ProbeError, report } from "./api";
import { fileInfo } from "./native";
import { keepAwake } from "./awake";

type Credential = {
  TmpSecretId: string;
  TmpSecretKey: string;
  SecurityToken: string;
  StartTime: number;
  ExpiredTime: number;
  Bucket: string;
  Region: string;
  Key: string;
};
type Pending = {
  runId: string;
  started: number;
  size: number;
  scenario: string;
  completedParts?: number;
  totalParts: number;
};
export type UploadView = {
  state: string;
  percent: number;
  size: number;
  matched: boolean;
  fingerprint: string;
  partsObserved: boolean;
  completedParts: number;
  sentParts: number;
  retransmittedParts: number;
  totalParts: number;
};
const pendingKey = "lyx_probe_upload_pending";
const tokensKey = "lyx_probe_upload_tokens";
let active: { cos: CosClient; taskId: string } | undefined;
let complete: (() => void) | undefined;
let current: Pending | undefined;

export async function recoverUpload() {
  const pending = Taro.getStorageSync<Pending>(pendingKey);
  if (!pending || current) return;
  await report({
    item: "V3",
    scenario: pending.scenario,
    sizeBytes: pending.size,
    durationMs: Date.now() - pending.started,
    result: "interrupted",
    errorCode: "PROCESS_INTERRUPTED",
    runId: pending.runId,
    attemptId: `${pending.runId}-interrupted`,
    completedParts: pending.completedParts,
    totalParts: pending.totalParts,
  });
  Taro.removeStorageSync(pendingKey);
}
export function pauseUpload() {
  if (active) active.cos.pauseTask(active.taskId);
}
export function resumeUpload() {
  if (active) active.cos.restartTask(active.taskId);
}
export function cancelUpload() {
  if (active) active.cos.cancelTask(active.taskId);
  complete?.();
}

export async function chooseUpload(compressed: boolean, fromChat: boolean) {
  await ensurePrivacy();
  if (fromChat) {
    const result = await Taro.chooseMessageFile({ count: 1, type: "file", extension: ["mp4"] });
    const file = result.tempFiles[0];
    return { path: file.path, size: file.size };
  }
  const result = await Taro.chooseMedia({
    count: 1,
    mediaType: ["video"],
    sourceType: ["album"],
    sizeType: [compressed ? "compressed" : "original"],
  });
  const file = result.tempFiles[0];
  return { path: file.tempFilePath, size: file.size };
}
export async function upload(
  file: { path: string; size: number },
  scenario: string,
  update: (view: UploadView) => void,
) {
  const releaseAwake = keepAwake();
  const started = Date.now();
  const runId = newId();
  const view: UploadView = {
    state: "计算本机文件摘要",
    percent: 0,
    size: file.size,
    matched: false,
    fingerprint: "",
    partsObserved: false,
    completedParts: 0,
    sentParts: 0,
    retransmittedParts: 0,
    totalParts: Math.ceil(file.size / (4 * 1024 * 1024)),
  };
  const refresh = () => update({ ...view });
  let result: "success" | "failure" | "cancelled" = "success";
  let code = "";
  refresh();
  try {
    // Native digest avoids reading a 500 MB file into JavaScript memory. A platform size failure is a measured failure.
    const info = await fileInfo(file.path, "sha1");
    if (info.size !== file.size) throw new ProbeError("FILE_CHANGED");
    const fingerprint = `${info.digest}-${info.size}`;
    const tokens = Taro.getStorageSync<Record<string, string>>(tokensKey) || {};
    view.matched = !!tokens[fingerprint];
    const clientToken = tokens[fingerprint] || `file-${newId()}`;
    tokens[fingerprint] = clientToken;
    Taro.setStorageSync(tokensKey, tokens);
    view.fingerprint = info.digest.slice(0, 12);
    const registered = await api<{ fileId: string; key: string }>("/uploads", "POST", {
      clientToken,
      size: info.size,
    });
    current = { started, runId, size: info.size, scenario, totalParts: view.totalParts };
    Taro.setStorageSync(pendingKey, current);
    const credentials = await api<Credential>(
      `/uploads/${registered.fileId}/credentials`,
      "POST",
      {},
    );
    if (await isFake()) {
      view.state = "FAKE：只验证登记、临时凭证与确认端点，未传文件";
    } else {
      await new Promise<void>((resolve, reject) => {
        let firstCredential = true;
        const cos = new COS({
          SimpleUploadMethod: "putObject",
          ChunkSize: 4 * 1024 * 1024,
          ChunkParallelLimit: 2,
          FileParallelLimit: 1,
          Timeout: 120000,
          getAuthorization: (_options: unknown, callback: (value: object) => void) => {
            const value = firstCredential
              ? Promise.resolve(credentials)
              : api<Credential>(`/uploads/${registered.fileId}/credentials`, "POST", {});
            firstCredential = false;
            void value
              .then((value) =>
                callback({
                  TmpSecretId: value.TmpSecretId,
                  TmpSecretKey: value.TmpSecretKey,
                  SecurityToken: value.SecurityToken,
                  StartTime: value.StartTime,
                  ExpiredTime: value.ExpiredTime,
                  ScopeLimit: true,
                }),
              )
              .catch(() => {
                if (active) cos.cancelTask(active.taskId);
                reject(new ProbeError("CREDENTIALS_UNAVAILABLE"));
              });
          },
        });
        // Observe public SDK method/event boundaries. Never persist UploadId, URLs, request headers or credentials.
        const existing = new Map<string, Set<number>>();
        const sent = new Map<string, Set<number>>();
        const originalList = cos.multipartListPart.bind(cos);
        cos.multipartListPart = (params, callback) =>
          originalList(params, (error, data) => {
            if (!error && data) {
              const id = String(params.UploadId);
              const parts = existing.get(id) || new Set<number>();
              for (const part of (data.Part || []) as { PartNumber: number | string }[])
                parts.add(Number(part.PartNumber));
              existing.set(id, parts);
              view.partsObserved = true;
              view.completedParts = parts.size;
              if (current) {
                current.completedParts = parts.size;
                Taro.setStorageSync(pendingKey, current);
              }
              refresh();
            }
            callback(error, data);
          });
        cos.on("before-send", (request) => {
          if (!request.qs?.uploadId) return;
          const id = request.qs.uploadId;
          const parts = sent.get(id) || new Set<number>();
          if (request.method === "PUT" && request.qs.partNumber)
            parts.add(Number(request.qs.partNumber));
          sent.set(id, parts);
          const completed = existing.get(id) || new Set<number>();
          view.partsObserved = existing.has(id);
          view.completedParts = completed.size;
          view.sentParts = parts.size;
          view.retransmittedParts = [...parts].filter((part) => completed.has(part)).length;
          if (current) {
            current.completedParts = view.partsObserved ? completed.size : undefined;
            Taro.setStorageSync(pendingKey, current);
          }
          refresh();
        });
        complete = () => reject(new ProbeError("CANCELLED"));
        cos.sliceUploadFile(
          {
            Bucket: credentials.Bucket,
            Region: credentials.Region,
            Key: credentials.Key,
            FilePath: file.path,
            FileSize: file.size,
            ChunkSize: 4 * 1024 * 1024,
            onTaskReady: (taskId: string) => {
              active = { cos, taskId };
            },
            onProgress: (progress: { percent: number }) => {
              view.state = "上传中";
              view.percent = Math.round(progress.percent * 100);
              refresh();
            },
          },
          (error) => (error ? reject(error) : resolve()),
        );
      });
      view.state = "上传完成，核对服务端大小";
    }
    await api(`/uploads/${registered.fileId}/confirm`, "POST", { size: info.size });
    view.percent = 100;
    if (!(await isFake())) view.state = "上传与大小核对成功";
  } catch (error) {
    if (active) active.cos.cancelTask(active.taskId);
    code = errorCode(error);
    result = code === "CANCELLED" ? "cancelled" : "failure";
    view.state = code;
  } finally {
    releaseAwake();
    active = undefined;
    complete = undefined;
    current = undefined;
    Taro.removeStorageSync(pendingKey);
    await report({
      item: "V3",
      scenario,
      sizeBytes: file.size,
      durationMs: Date.now() - started,
      result,
      errorCode: code,
      runId,
      totalParts: view.totalParts,
      sentParts: view.sentParts,
      ...(view.partsObserved
        ? { completedParts: view.completedParts, retransmittedParts: view.retransmittedParts }
        : {}),
      phase: view.partsObserved ? "parts_observed" : "parts_unobserved",
    });
    refresh();
  }
}
