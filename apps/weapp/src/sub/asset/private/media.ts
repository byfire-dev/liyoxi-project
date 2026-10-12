import type { AssetDetail, AssetFile } from "./api";

export interface AssetMediaPorts {
  privacy(): Promise<boolean>;
  image(urls: string[], current: string): Promise<unknown>;
  video(url: string, fileId: string): void;
  stopVideo(): void;
  download(url: string): {
    promise: Promise<{ statusCode: number; tempFilePath: string }>;
    abort(): void;
  };
  document(path: string): Promise<unknown>;
  unlink(path: string): void;
  audio(): {
    src: string;
    play(): void;
    pause(): void;
    stop(): void;
    destroy(): void;
    onError(run: () => void): void;
    onEnded(run: () => void): void;
  };
}
/** 只编排原生端口；不把请求时间当云文件可达／格式验真。 */
export function createAssetMedia(deps: {
  ports: AssetMediaPorts;
  scope(): string | null;
  detail(): AssetDetail | null;
  refresh(): Promise<void>;
  now(): number;
  publish(message: string | null, playing: string | null): void;
}) {
  const scope = deps.scope();
  let alive = true,
    generation = 0;
  let download: ReturnType<AssetMediaPorts["download"]> | null = null;
  let audio: ReturnType<AssetMediaPorts["audio"]> | null = null;
  let playing: string | null = null;
  const current = () => alive && scope !== null && deps.scope() === scope;
  const stop = () => {
    generation++;
    download?.abort();
    download = null;
    audio?.stop();
    audio?.destroy();
    audio = null;
    playing = null;
    deps.ports.stopVideo();
    if (current()) deps.publish(null, null);
  };
  const open = async (fileId: string, renew = false) => {
    if (!current()) return;
    if (!renew && playing === fileId && audio) {
      audio.pause();
      playing = null;
      deps.publish(null, null);
      return;
    }
    stop();
    const own = generation;
    const assetId = deps.detail()?.storeAssetId;
    const valid = () => current() && own === generation && deps.detail()?.storeAssetId === assetId;
    const file = () => deps.detail()?.files.find((item) => item.fileId === fileId);
    let local: string | null = null;
    try {
      if (!(await deps.ports.privacy()) || !valid()) return;
      let selected = file();
      if (
        renew ||
        !selected?.url ||
        (selected.expiresAt && Date.parse(selected.expiresAt) <= deps.now())
      ) {
        await deps.refresh();
        if (!valid()) return;
        selected = file();
      }
      if (!selected?.url || (selected.expiresAt && Date.parse(selected.expiresAt) <= deps.now()))
        throw new Error("unavailable");
      const source = selected.url;
      const sourceCurrent = () =>
        valid() && file()?.url === source && fileAvailable(file()!, deps.now());
      if (selected.kind === "image") {
        const urls =
          deps
            .detail()
            ?.files.filter(
              (item) =>
                item.kind === "image" &&
                item.url &&
                (!item.expiresAt || Date.parse(item.expiresAt) > deps.now()),
            )
            .map((item) => item.url!) ?? [];
        if (sourceCurrent()) await deps.ports.image(urls, source);
      } else if (selected.kind === "video") {
        if (sourceCurrent()) deps.ports.video(source, fileId);
      } else if (selected.kind === "document") {
        download = deps.ports.download(source);
        const result = await download.promise;
        local = result.tempFilePath;
        if (!sourceCurrent()) return;
        if (result.statusCode !== 200 || !local) throw new Error("download");
        await deps.ports.document(local);
      } else if (selected.kind === "audio") {
        audio = deps.ports.audio();
        audio.src = source;
        audio.onError(() => {
          if (sourceCurrent()) {
            stop();
            deps.publish("音频暂时无法播放，请重新获取文件", null);
          }
        });
        audio.onEnded(() => {
          if (sourceCurrent()) {
            playing = null;
            deps.publish(null, null);
          }
        });
        if (sourceCurrent()) {
          playing = fileId;
          audio.play();
          deps.publish(null, fileId);
        }
      }
    } catch {
      if (valid()) deps.publish("文件暂时无法预览，请重新获取后重试", null);
    } finally {
      if (local) deps.ports.unlink(local);
      if (valid()) download = null;
    }
  };
  return {
    open,
    stop,
    dispose: () => {
      alive = false;
      stop();
    },
    current,
  };
}

export function fileAvailable(file: AssetFile, now: number): boolean {
  return !!file.url && (!file.expiresAt || Date.parse(file.expiresAt) > now);
}
