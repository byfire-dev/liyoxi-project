import { PortalApiError } from "../../lib/api-errors";
import type { DownloadResult, ItemApi } from "./api";

export type ZipState = "idle" | "building" | "ready" | "failed" | "timeout" | "cancelled";
export const ZIP_TIMEOUT_MS = 10 * 60 * 1000;

export function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(new PortalApiError("REQUEST_ABORTED"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Only a deliberate failed-state retry may start a new ZIP generation. */
export async function requestZip(options: {
  api: ItemApi;
  id: string;
  signal: AbortSignal;
  retry: boolean;
  current: () => boolean;
  building: () => void;
  now?: () => number;
  wait?: typeof waitForPoll;
}): Promise<DownloadResult | "timeout"> {
  const now = options.now ?? Date.now;
  const deadline = now() + ZIP_TIMEOUT_MS;
  const timeout = new AbortController();
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), ZIP_TIMEOUT_MS);
  let retry = options.retry;
  try {
    for (;;) {
      if (options.signal.aborted || !options.current()) throw new PortalApiError("REQUEST_ABORTED");
      if (now() >= deadline) return "timeout";
      const result = await options.api.download(options.id, { kind: "zip", retry }, signal);
      if (options.signal.aborted || !options.current()) throw new PortalApiError("REQUEST_ABORTED");
      if (now() >= deadline) return "timeout";
      if (result.kind !== "zip" || result.state === "none")
        throw new PortalApiError("INVALID_RESPONSE");
      if (result.state !== "building") return result;
      if (result.pollAfterSec !== 5) throw new PortalApiError("INVALID_RESPONSE");
      options.building();
      retry = false;
      await (options.wait ?? waitForPoll)(
        Math.min(result.pollAfterSec * 1000, deadline - now()),
        signal,
      );
    }
  } catch (error) {
    if (timeout.signal.aborted && !options.signal.aborted && options.current()) return "timeout";
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function downloadHref(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PortalApiError("INVALID_RESPONSE");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new PortalApiError("INVALID_RESPONSE");
  return url.href;
}
export function saveDownload(result: DownloadResult) {
  if (result.state !== "ready" || !result.url || !result.fileName || !result.downloadId)
    throw new PortalApiError("INVALID_RESPONSE");
  const anchor = document.createElement("a");
  anchor.href = downloadHref(result.url);
  anchor.download = result.fileName;
  anchor.rel = "noopener noreferrer";
  anchor.referrerPolicy = "no-referrer";
  anchor.target = "_blank";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}
export function saveText(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName.replace(/[\\/:*?"<>|]/g, "_");
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
