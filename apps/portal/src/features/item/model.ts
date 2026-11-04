import type { PortalSessionStore } from "../session/model";
import { PortalApiError, safePortalError } from "../../lib/api-errors";
import type { DownloadResult, ItemApi, PublishList, Release } from "./api";
import { requestZip, saveDownload, saveText, type ZipState } from "./download";

export interface ItemSnapshot {
  readonly release: Release | null;
  readonly publishList: PublishList | null;
  readonly loading: boolean;
  readonly error: string;
  readonly actionError: string;
  readonly textError: string;
  readonly notice: string;
  readonly episode: number | null;
  readonly textBusy: boolean;
  readonly zip: ZipState;
}
export function createItemModel(
  api: ItemApi,
  session: PortalSessionStore,
  id: string,
  effects: {
    saveDownload: typeof saveDownload;
    saveText: typeof saveText;
    copyText: (text: string) => Promise<void>;
    now?: () => number;
  } = {
    saveDownload,
    saveText,
    copyText: (text: string) => navigator.clipboard.writeText(text),
  },
) {
  let snapshot: ItemSnapshot = {
    release: null,
    publishList: null,
    loading: true,
    error: "",
    actionError: "",
    textError: "",
    notice: "",
    episode: null,
    textBusy: false,
    zip: "idle",
  };
  const listeners = new Set<() => void>();
  const active = new Map<string, AbortController>();
  const publish = (patch: Partial<ItemSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  function start(key: string) {
    const scope = session.captureScope();
    if (!scope || active.has(key)) return null;
    const controller = new AbortController();
    active.set(key, controller);
    const signal = AbortSignal.any([scope.signal, controller.signal]);
    return {
      signal,
      current: () => scope.isCurrent() && !signal.aborted,
      finish: () => {
        if (active.get(key) === controller) active.delete(key);
      },
    };
  }
  async function readRelease(signal: AbortSignal) {
    const value = await api.release(id, signal);
    if (value.orderItemId !== id) throw new PortalApiError("INVALID_RESPONSE");
    return value;
  }
  async function readText(signal: AbortSignal, release: Release) {
    const value = await api.publishList(id, signal);
    if (value.orderItemId !== id || value.releaseNo !== release.releaseNo)
      throw new PortalApiError("INVALID_RESPONSE");
    return value;
  }
  async function load() {
    const task = start("load");
    if (!task) return;
    publish({ loading: true, error: "", textError: "" });
    try {
      const release = await readRelease(task.signal);
      if (!task.current()) return;
      publish({ release, publishList: null, loading: false });
      if (release.hasPublishList) {
        try {
          const publishList = await readText(task.signal, release);
          if (task.current()) publish({ publishList });
        } catch (error) {
          if (task.current()) publish({ textError: safePortalError(error).message });
        }
      }
    } catch (error) {
      if (task.current())
        publish({
          release: null,
          publishList: null,
          error: safePortalError(error).message,
          loading: false,
        });
    } finally {
      task.finish();
    }
  }
  function allowed() {
    return snapshot.release?.isDownloadable === true;
  }
  function ready(result: DownloadResult, expected: DownloadResult["kind"]) {
    if (
      result.kind !== expected ||
      result.state !== "ready" ||
      !result.url ||
      !result.downloadId ||
      !result.fileName ||
      !result.expiresAt ||
      !Number.isFinite(Date.parse(result.expiresAt)) ||
      Date.parse(result.expiresAt) <= (effects.now ?? Date.now)()
    )
      throw new PortalApiError("INVALID_RESPONSE");
    effects.saveDownload(result);
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    async episode(episodeNo: number) {
      if (!allowed() || !snapshot.release?.episodes.some((entry) => entry.episodeNo === episodeNo))
        return;
      const task = start("episode");
      if (!task) return;
      publish({ episode: episodeNo, actionError: "", notice: "" });
      try {
        const result = await api.download(id, { kind: "episode", episodeNo }, task.signal);
        if (!task.current()) return;
        if (result.episodeNo !== episodeNo) throw new PortalApiError("INVALID_RESPONSE");
        ready(result, "episode");
        publish({ notice: `第 ${episodeNo} 集已获取下载地址，请在浏览器下载记录中查看保存进度。` });
        const release = await readRelease(task.signal);
        if (task.current()) {
          const sameRelease = snapshot.publishList?.releaseNo === release.releaseNo;
          publish({ release, publishList: sameRelease ? snapshot.publishList : null });
          if (release.hasPublishList && !sameRelease) {
            const publishList = await readText(task.signal, release);
            if (task.current()) publish({ publishList });
          }
        }
      } catch (error) {
        if (task.current()) publish({ actionError: safePortalError(error).message });
      } finally {
        if (task.current()) publish({ episode: null });
        task.finish();
      }
    },
    async zip(retry = false) {
      if (!allowed() || (retry && snapshot.zip !== "failed")) return;
      const task = start("zip");
      if (!task) return;
      publish({ zip: "building", actionError: "", notice: "" });
      try {
        const result = await requestZip({
          api,
          id,
          signal: task.signal,
          current: task.current,
          retry,
          building: () => {
            if (task.current()) publish({ zip: "building" });
          },
        });
        if (!task.current()) return;
        if (result === "timeout") publish({ zip: "timeout" });
        else if (result.state === "failed") publish({ zip: "failed" });
        else {
          ready(result, "zip");
          publish({
            zip: "ready",
            notice: "整包已获取下载地址，请在浏览器下载记录中查看保存进度。",
          });
        }
      } catch (error) {
        if (task.current()) publish({ zip: "idle", actionError: safePortalError(error).message });
      } finally {
        task.finish();
      }
    },
    cancelZip() {
      active.get("zip")?.abort();
      active.delete("zip");
      publish({ zip: "cancelled" });
    },
    async publishText(download: boolean) {
      const release = snapshot.release;
      if (!release?.hasPublishList || (download && !allowed())) return;
      const task = start("text");
      if (!task) return;
      publish({ textBusy: true, actionError: "", notice: "" });
      try {
        if (download) {
          const result = await api.download(id, { kind: "publish_list" }, task.signal);
          if (!task.current()) return;
          if (result.kind !== "publish_list") throw new PortalApiError("INVALID_RESPONSE");
          if (result.state === "ready") {
            ready(result, "publish_list");
            publish({ notice: "发布清单已获取下载地址，请查看浏览器下载记录。" });
            return;
          }
        }
        // GET supplies authoritative text; this fallback never requests ZIP generation.
        const publishList = await readText(task.signal, release);
        if (!task.current()) return;
        publish({ publishList, textError: "" });
        if (!publishList.text) throw new PortalApiError("FILE_NOT_AVAILABLE");
        if (download) effects.saveText(publishList.text, `${release.dramaTitle}_发布清单.txt`);
        else await effects.copyText(publishList.text);
        if (task.current())
          publish({ notice: download ? "已生成发布清单文本文件。" : "已复制发布清单。" });
      } catch (error) {
        if (task.current()) publish({ actionError: safePortalError(error).message });
      } finally {
        if (task.current()) publish({ textBusy: false });
        task.finish();
      }
    },
    stop() {
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  };
}
