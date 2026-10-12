import Taro from "@tarojs/taro";
import { withPrivacy } from "@/lib/runtime";
import { prepareTaroFile } from "@/lib/upload/taro";
import type { SelectedFile } from "@/lib/upload/queue";
import type { UploadType } from "./upload-model";
export interface RecordingTask {
  done: Promise<SelectedFile>;
  stop(): void;
}
export interface AssetPlatformDeps {
  current(): boolean;
  choose(type: UploadType, count: number): Promise<SelectedFile[]>;
  prepare(file: SelectedFile): Promise<SelectedFile | null>;
  authorizeRecord(): Promise<void>;
  record(): RecordingTask;
  play(file: SelectedFile, onError: () => void): { stop(): void };
}
export function createAssetUploadPlatform(deps: AssetPlatformDeps) {
  let generation = 0,
    alive = true,
    selecting = false,
    recordStarting = false;
  let recording: RecordingTask | null = null,
    player: { stop(): void } | null = null;
  let state = { recording: false, listening: false, message: null as string | null };
  const listeners = new Set<() => void>();
  const current = (own = generation) => alive && own === generation && deps.current();
  const publish = (patch: Partial<typeof state>) => {
    if (current()) {
      state = { ...state, ...patch };
      listeners.forEach((run) => run());
    }
  };
  const stopAudio = () => {
    player?.stop();
    player = null;
    publish({ listening: false });
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async choose(type: UploadType, count: number, resume = false): Promise<SelectedFile[]> {
      if (selecting || !current() || type === "text") return [];
      selecting = true;
      const own = generation;
      try {
        const selected = await deps.choose(type, Math.min(9, Math.max(1, count)));
        if (!current(own)) return [];
        const files: SelectedFile[] = [];
        for (const file of selected) {
          const prepared = resume ? file : await deps.prepare(file);
          if (!current(own)) return [];
          if (prepared) files.push(prepared);
        }
        return files;
      } finally {
        selecting = false;
      }
    },
    async record(): Promise<SelectedFile | null> {
      if (recording || recordStarting || !current()) return null;
      recordStarting = true;
      const own = generation;
      try {
        await deps.authorizeRecord();
        if (!current(own)) return null;
        recording = deps.record();
        publish({ recording: true, message: null });
        const file = await recording.done;
        if (!current(own)) return null;
        if (
          file.durationMs === undefined ||
          file.durationMs <= 0 ||
          file.durationMs > 300000 ||
          file.size <= 0
        )
          throw new Error("录音为空或超过5分钟，请重新录制");
        const prepared = await deps.prepare(file);
        return current(own) ? prepared : null;
      } catch (error) {
        if (current(own))
          publish({
            message: error instanceof Error ? error.message : "录音失败，请检查麦克风授权",
          });
        return null;
      } finally {
        recordStarting = false;
        if (current(own)) {
          recording = null;
          publish({ recording: false });
        }
      }
    },
    stopRecording() {
      recording?.stop();
    },
    listen(file: SelectedFile) {
      if (!current()) return;
      if (player) {
        stopAudio();
        return;
      }
      const own = generation;
      player = deps.play(file, () => {
        if (current(own)) {
          stopAudio();
          publish({ message: "试听失败，请重新选择文件" });
        }
      });
      publish({ listening: true });
    },
    reset() {
      generation++;
      recording?.stop();
      recording = null;
      stopAudio();
      publish({ recording: false, message: null });
    },
    dispose() {
      alive = false;
      generation++;
      recording?.stop();
      player?.stop();
      recording = null;
      player = null;
      listeners.clear();
    },
  };
}
let recorderBound = false;
let activeRecording: { resolve(file: SelectedFile): void; reject(error: Error): void } | null =
  null;
export function createNativeAssetUploadPlatform(current: () => boolean) {
  const privacy = async <T>(handler: () => Promise<T>): Promise<T> => {
    const result = await withPrivacy(() => {
      if (!current()) throw new Error("原门店已变化");
      return handler();
    });
    if (!result.ok) throw new Error("请先同意隐私指引，再选择文件或录音");
    return result.value;
  };
  return createAssetUploadPlatform({
    current,
    prepare: (file) => prepareTaroFile(file, "store_asset"),
    choose: (type, count) =>
      privacy(async () => {
        if (type === "image" || type === "video") {
          const result = await Taro.chooseMedia({
            count,
            mediaType: [type],
            sizeType: ["original"],
            maxDuration: 60,
          });
          const files: SelectedFile[] = [];
          for (const file of result.tempFiles) {
            if (!current()) return [];
            const info =
              type === "image" ? await Taro.getImageInfo({ src: file.tempFilePath }) : null;
            if (!current()) return [];
            files.push({
              path: file.tempFilePath,
              name: `upload.${info?.type ?? /\.([a-z0-9]+)$/iu.exec(file.tempFilePath)?.[1] ?? "mp4"}`,
              size: file.size,
              width: file.width ?? info?.width ?? 0,
              height: file.height ?? info?.height ?? 0,
              durationMs: Math.round((file.duration ?? 0) * 1000),
            });
          }
          return files;
        }
        if (process.env.TARO_ENV !== "weapp")
          throw new Error("请在微信中从聊天选择文件；H5不提供原生文件能力");
        const result = await Taro.chooseMessageFile({
          count,
          type: "file",
          extension: type === "document" ? ["pdf", "docx", "txt"] : ["mp3", "m4a", "wav", "aac"],
        });
        return result.tempFiles.map((file) => ({
          path: file.path,
          name: file.name,
          size: file.size,
        }));
      }),
    authorizeRecord: () =>
      privacy(async () => {
        if (process.env.TARO_ENV !== "weapp") throw new Error("请在微信中录音，H5不证明麦克风授权");
        await Taro.authorize({ scope: "scope.record" });
      }),
    record: () => {
      if (activeRecording) throw new Error("上一段录音正在结束，请等待实际停止");
      const recorder = Taro.getRecorderManager();
      if (!recorderBound) {
        recorderBound = true;
        recorder.onStop((file) => {
          const active = activeRecording;
          activeRecording = null;
          active?.resolve({
            path: file.tempFilePath,
            name: "recording.mp3",
            size: file.fileSize,
            durationMs: file.duration,
          });
        });
        recorder.onError((error) => {
          const active = activeRecording;
          activeRecording = null;
          active?.reject(new Error(error.errMsg));
        });
      }
      const done = new Promise<SelectedFile>((resolve, reject) => {
        activeRecording = { resolve, reject };
      });
      try {
        recorder.start({
          duration: 300000,
          format: "mp3",
          sampleRate: 16000,
          numberOfChannels: 1,
          encodeBitRate: 48000,
        });
      } catch (error) {
        activeRecording = null;
        throw error;
      }
      return { done, stop: () => recorder.stop() };
    },
    play: (file, onError) => {
      const audio = Taro.createInnerAudioContext();
      audio.src = file.path;
      audio.onError(onError);
      audio.play();
      return {
        stop: () => {
          audio.stop();
          audio.destroy();
        },
      };
    },
  });
}
export type AssetUploadPlatform = ReturnType<typeof createAssetUploadPlatform>;
