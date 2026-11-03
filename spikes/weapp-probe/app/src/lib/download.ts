import Taro from "@tarojs/taro";
import {
  api,
  baseUrl,
  ensurePrivacy,
  errorCode,
  getProbeMode,
  newId,
  ProbeError,
  quarantine,
  report,
} from "./api";
import type { ProbeMode } from "./api";
import { fileInfo } from "./native";
import { keepAwake } from "./awake";

export type DiskMode = "temp" | "user_dir";
type Job = {
  index: number;
  status: "pending" | "downloading" | "saving" | "saved" | "failed" | "interrupted" | "cancelled";
  error: string;
  attempt: number;
  started?: number;
};
export type Queue = {
  probeMode: ProbeMode;
  serviceUrl: string;
  runId: string;
  sizeMb: number;
  mode: DiskMode;
  scenario: string;
  paused: boolean;
  jobs: Job[];
};
type Signed = { url: string; size: number; expiresAt: string; timeoutMs: number };
const queueKey = "lyx_probe_download_queue";
const filesKey = "lyx_probe_download_files";
let queue: Queue | undefined;
let initialization: Promise<void> | undefined;
let working = 0;
const tasks = new Map<number, { abort(): void }>();
const listeners = new Set<(value: Queue | undefined) => void>();
const snapshot = () => (queue ? structuredQueue(queue) : undefined);
const structuredQueue = (value: Queue): Queue => ({
  ...value,
  jobs: value.jobs.map((job) => ({ ...job })),
});
const publish = () => {
  if (queue) Taro.setStorageSync(queueKey, queue);
  listeners.forEach((listener) => listener(snapshot()));
};
export function subscribeDownloads(listener: (value: Queue | undefined) => void) {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}
function remember(file: string) {
  const files = Taro.getStorageSync<string[]>(filesKey) || [];
  if (!files.includes(file)) Taro.setStorageSync(filesKey, [...files, file]);
}
export function residualFiles() {
  return (Taro.getStorageSync<string[]>(filesKey) || []).length;
}
async function unlink(file: string) {
  try {
    await new Promise<void>((resolve, reject) =>
      Taro.getFileSystemManager().unlink({
        filePath: file,
        success: () => resolve(),
        fail: reject,
      }),
    );
  } catch (error) {
    const message = String((error as { errMsg?: string }).errMsg || "");
    if (!/no such file|not exist/i.test(message)) throw new ProbeError("TEMP_CLEANUP_FAILED");
  }
  const files = Taro.getStorageSync<string[]>(filesKey) || [];
  Taro.setStorageSync(
    filesKey,
    files.filter((path) => path !== file),
  );
}
export async function cleanResidualFiles() {
  const files = Taro.getStorageSync<string[]>(filesKey) || [];
  for (const file of files) await unlink(file);
}
export async function initializeDownloads(): Promise<void> {
  if (!initialization) {
    initialization = initialize();
    try {
      await initialization;
    } catch (error) {
      initialization = undefined;
      throw error;
    }
  } else {
    await initialization;
    isolateQueue(await getProbeMode(true));
  }
}
function isolateQueue(mode: ProbeMode) {
  if (!queue || (queue.probeMode === mode && queue.serviceUrl === baseUrl)) return;
  queue.paused = true;
  tasks.forEach((task) => task.abort());
  quarantine("download_queue", queue);
  queue = undefined;
  Taro.removeStorageSync(queueKey);
  publish();
}
async function initialize() {
  const mode = await getProbeMode(true);
  queue = Taro.getStorageSync<Queue>(queueKey) || undefined;
  isolateQueue(mode);
  if (queue) {
    queue.paused = true;
    for (const job of queue.jobs) {
      if (job.status === "downloading" || job.status === "saving") {
        const previous = job.status;
        job.status = previous === "saving" ? "failed" : "interrupted";
        job.error = previous === "saving" ? "SAVE_RESULT_UNKNOWN" : "PROCESS_INTERRUPTED";
        await report(
          {
            item: "V7",
            scenario: queue.scenario,
            sizeBytes: queue.sizeMb * 1000000,
            durationMs: Date.now() - (job.started || Date.now()),
            result: "interrupted",
            errorCode: job.error,
            mode: queue.mode,
            runId: queue.runId,
            index: job.index,
            attemptId: `${queue.runId}-${job.index}-${job.attempt}`,
            phase: previous,
          },
          queue.probeMode,
        );
      }
    }
  }
  await cleanResidualFiles().catch(() => undefined);
  publish();
}
async function authorizeAlbum() {
  await ensurePrivacy();
  const settings = await Taro.getSetting();
  if (settings.authSetting["scope.writePhotosAlbum"] === false)
    throw new ProbeError("ALBUM_PERMISSION_DENIED");
  await Taro.authorize({ scope: "scope.writePhotosAlbum" });
}
export async function startDownloads(
  sizeMb: number,
  count: number,
  mode: DiskMode,
  scenario: string,
) {
  await initializeDownloads();
  if (
    working ||
    queue?.jobs.some(
      (job) =>
        ["pending", "interrupted"].includes(job.status) || job.error === "SAVE_RESULT_UNKNOWN",
    )
  )
    throw new ProbeError("QUEUE_NOT_FINISHED");
  const started = Date.now();
  const originMode = await getProbeMode();
  try {
    if (originMode === "real") await authorizeAlbum();
  } catch (error) {
    const code = errorCode(error);
    await report(
      {
        item: "V7",
        scenario,
        sizeBytes: sizeMb * 1000000,
        durationMs: Date.now() - started,
        result: code === "CANCELLED" ? "cancelled" : "failure",
        errorCode: code,
        mode,
        phase: "preflight",
      },
      originMode,
    );
    throw error;
  }
  queue = {
    probeMode: originMode,
    serviceUrl: baseUrl,
    runId: newId(),
    sizeMb,
    mode,
    scenario,
    paused: false,
    jobs: Array.from({ length: count }, (_, index) => ({
      index: index + 1,
      status: "pending",
      error: "",
      attempt: 0,
    })),
  };
  publish();
  pump();
}
export function pauseDownloads(abort = true) {
  if (!queue) return;
  queue.paused = true;
  if (abort) tasks.forEach((task) => task.abort());
  publish();
}
export function resumeDownloads() {
  if (!queue) return;
  queue.jobs.forEach((job) => {
    if (job.status === "interrupted") job.status = "pending";
  });
  queue.paused = false;
  publish();
  pump();
}
export function retryFailedDownloads() {
  if (!queue || working) return;
  queue.jobs.forEach((job) => {
    if (job.status === "failed" && job.error !== "SAVE_RESULT_UNKNOWN") {
      job.status = "pending";
      job.error = "";
    }
  });
  queue.paused = false;
  publish();
  pump();
}
export async function resolveUnknownDownload(index: number, saved: boolean) {
  if (!queue || working) throw new ProbeError("PAUSE_AND_WAIT");
  const job = queue.jobs.find(
    (entry) => entry.index === index && entry.error === "SAVE_RESULT_UNKNOWN",
  );
  if (!job) return;
  job.status = saved ? "saved" : "pending";
  job.error = "";
  publish();
  await report(
    {
      item: "V7",
      scenario: queue.scenario,
      sizeBytes: queue.sizeMb * 1000000,
      durationMs: 0,
      result: saved ? "success" : "interrupted",
      errorCode: saved ? "" : "MANUALLY_NOT_SAVED",
      mode: queue.mode,
      runId: queue.runId,
      index,
      phase: saved ? "album_manually_confirmed" : "album_retry_confirmed",
    },
    queue.probeMode,
  );
  if (!saved) resumeDownloads();
}
export async function abandonDownloads() {
  if (!queue || working) throw new ProbeError("PAUSE_AND_WAIT");
  for (const job of queue.jobs) {
    if (job.status === "pending" || job.status === "interrupted") {
      job.status = "cancelled";
      await report(
        {
          item: "V7",
          scenario: queue.scenario,
          sizeBytes: queue.sizeMb * 1000000,
          durationMs: 0,
          result: "cancelled",
          errorCode: "QUEUE_ABANDONED",
          mode: queue.mode,
          runId: queue.runId,
          index: job.index,
          phase: "queue",
        },
        queue.probeMode,
      );
    }
  }
  publish();
}
function pump() {
  if (!queue || queue.paused) return;
  while (working < 2) {
    const job = queue.jobs.find((entry) => entry.status === "pending");
    if (!job) break;
    job.status = "downloading";
    working++;
    job.attempt++;
    job.started = Date.now();
    publish();
    void perform(queue, job).finally(() => {
      working--;
      publish();
      pump();
    });
  }
}
async function perform(run: Queue, job: Job) {
  const releaseAwake = keepAwake();
  let file: string | undefined;
  let saved = false;
  let phase = "signing";
  let code = "";
  let result: "success" | "failure" | "interrupted" = "success";
  let size = run.sizeMb * 1000000;
  try {
    if (run.probeMode !== (await getProbeMode(true)) || run.serviceUrl !== baseUrl) {
      run.paused = true;
      throw new ProbeError("PROBE_MODE_MISMATCH");
    }
    const signed = await api<Signed>(`/downloads/${run.sizeMb}?mode=${run.mode}`);
    size = signed.size;
    if (run.probeMode === "fake") {
      job.status = "saved";
      phase = "fake_endpoints_only";
      return;
    }
    if (run.paused) throw new ProbeError("INTERRUPTED");
    phase = "downloading";
    const chosenPath =
      run.mode === "user_dir"
        ? `${Taro.env.USER_DATA_PATH}/lyx-probe-${run.runId}-${job.index}.mp4`
        : undefined;
    if (chosenPath) {
      file = chosenPath;
      remember(chosenPath);
    }
    const response = await new Promise<Taro.downloadFile.FileSuccessCallbackResult>(
      (resolve, reject) => {
        const task = Taro.downloadFile({
          url: signed.url,
          timeout: signed.timeoutMs,
          ...(chosenPath ? { filePath: chosenPath } : {}),
          success: resolve,
          fail: reject,
        });
        tasks.set(job.index, task);
      },
    );
    tasks.delete(job.index);
    file = response.tempFilePath || response.filePath || chosenPath;
    if (file) remember(file);
    if (response.statusCode !== 200 || !file) throw new ProbeError("DOWNLOAD_FAILED");
    const info = await fileInfo(file);
    if (info.size !== signed.size) throw new ProbeError("DOWNLOAD_SIZE_MISMATCH");
    phase = "saving";
    job.status = "saving";
    publish();
    await Taro.saveVideoToPhotosAlbum({ filePath: file });
    saved = true;
    job.status = "saved";
    phase = "saved";
  } catch (error) {
    code = errorCode(error);
    result = run.paused || code === "INTERRUPTED" ? "interrupted" : "failure";
    job.status = result === "interrupted" ? "interrupted" : "failed";
    job.error = code;
  } finally {
    releaseAwake();
    tasks.delete(job.index);
    if (file) {
      try {
        await unlink(file);
      } catch {
        code = "TEMP_CLEANUP_FAILED";
        result = "failure";
        job.error = code;
        phase = saved ? "saved_cleanup_failed" : "cleanup_failed";
      }
    }
    await report(
      {
        item: "V7",
        scenario: run.scenario,
        sizeBytes: size,
        durationMs: Date.now() - (job.started || Date.now()),
        result,
        errorCode: code,
        mode: run.mode,
        runId: run.runId,
        index: job.index,
        attemptId: `${run.runId}-${job.index}-${job.attempt}`,
        phase,
      },
      run.probeMode,
    );
  }
}
