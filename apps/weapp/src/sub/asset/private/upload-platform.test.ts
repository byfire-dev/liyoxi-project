import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectedFile } from "@/lib/upload/queue";
import { createAssetUploadPlatform, createNativeAssetUploadPlatform } from "./upload-platform";
import type { AssetPlatformDeps } from "./upload-platform";

const native = vi.hoisted(() => ({
  privacy: vi.fn(async (handler: () => Promise<unknown>) => ({ ok: true, value: await handler() })),
  prepare: vi.fn(async (file: unknown) => file),
  chooseMedia: vi.fn(),
  getImageInfo: vi.fn(),
  chooseMessageFile: vi.fn(),
  authorize: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  onStop: vi.fn(),
  onError: vi.fn(),
  play: vi.fn(),
  audioStop: vi.fn(),
  destroy: vi.fn(),
  audioError: vi.fn(),
}));
vi.mock("@/lib/runtime", () => ({ withPrivacy: native.privacy }));
vi.mock("@/lib/upload/taro", () => ({ prepareTaroFile: native.prepare }));
vi.mock("@tarojs/taro", () => ({
  default: {
    chooseMedia: native.chooseMedia,
    getImageInfo: native.getImageInfo,
    chooseMessageFile: native.chooseMessageFile,
    authorize: native.authorize,
    getRecorderManager: () => ({
      start: native.start,
      stop: native.stop,
      onStop: native.onStop,
      onError: native.onError,
    }),
    createInnerAudioContext: () => ({
      src: "",
      play: native.play,
      stop: native.audioStop,
      destroy: native.destroy,
      onError: native.audioError,
    }),
  },
}));
const file = (name = "a.png"): SelectedFile => ({ name, path: `wxfile://${name}`, size: 9 });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function harness() {
  let current = true;
  const done = deferred<SelectedFile>();
  const stopRecording = vi.fn(),
    stopPlayer = vi.fn();
  const deps: AssetPlatformDeps = {
    current: () => current,
    choose: vi.fn(async () => [file()]),
    prepare: vi.fn(async (value) => value),
    authorizeRecord: vi.fn(async () => {}),
    record: vi.fn(() => ({ done: done.promise, stop: stopRecording })),
    play: vi.fn(() => ({ stop: stopPlayer })),
  };
  return {
    deps,
    done,
    stopRecording,
    stopPlayer,
    platform: createAssetUploadPlatform(deps),
    change: () => {
      current = false;
    },
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("文件选择与录音的代次边界", () => {
  it.each([
    [-4, 1],
    [1, 1],
    [99, 9],
  ])("选择数量%i被限制为%i", async (count, expected) => {
    const h = harness();
    expect(await h.platform.choose("image", count)).toEqual([file()]);
    expect(h.deps.choose).toHaveBeenCalledWith("image", expected);
  });
  it("文字不调用选择器；重选直接校验原上传字节，不再次压缩", async () => {
    const h = harness();
    expect(await h.platform.choose("text", 1)).toEqual([]);
    expect(h.deps.choose).not.toHaveBeenCalled();
    expect(await h.platform.choose("image", 1, true)).toEqual([file()]);
    expect(h.deps.prepare).not.toHaveBeenCalled();
  });
  it("选择器单飞，迟到选择结果在reset后丢弃", async () => {
    const h = harness(),
      pick = deferred<SelectedFile[]>();
    vi.mocked(h.deps.choose).mockReturnValue(pick.promise);
    const first = h.platform.choose("image", 2);
    expect(await h.platform.choose("video", 1)).toEqual([]);
    h.platform.reset();
    pick.resolve([file()]);
    expect(await first).toEqual([]);
    expect(h.deps.choose).toHaveBeenCalledTimes(1);
    expect(h.deps.prepare).not.toHaveBeenCalled();
  });
  it.each(["scope", "reset", "dispose"])(
    "prepare等待期间%s变化，丢弃结果且不准备下一文件",
    async (change) => {
      const h = harness(),
        prepared = deferred<SelectedFile | null>();
      vi.mocked(h.deps.choose).mockResolvedValue([file(), file("b.png")]);
      vi.mocked(h.deps.prepare).mockReturnValue(prepared.promise);
      const work = h.platform.choose("image", 2);
      await Promise.resolve();
      if (change === "scope") h.change();
      else h.platform[change === "reset" ? "reset" : "dispose"]();
      prepared.resolve(file());
      expect(await work).toEqual([]);
      expect(h.deps.prepare).toHaveBeenCalledTimes(1);
    },
  );
  it("预检拒绝的文件不返回；选择异常之后可再次选择", async () => {
    const h = harness();
    vi.mocked(h.deps.choose).mockRejectedValueOnce(new Error("picker failed"));
    await expect(h.platform.choose("image", 1)).rejects.toThrow("picker failed");
    vi.mocked(h.deps.prepare).mockResolvedValue(null);
    expect(await h.platform.choose("image", 1)).toEqual([]);
    expect(h.deps.choose).toHaveBeenCalledTimes(2);
  });
  it("录音授权拒绝不打开设备并显示实际错误", async () => {
    const h = harness();
    vi.mocked(h.deps.authorizeRecord).mockRejectedValue(new Error("denied"));
    expect(await h.platform.record()).toBeNull();
    expect(h.deps.record).not.toHaveBeenCalled();
    expect(h.platform.snapshot()).toEqual({
      recording: false,
      listening: false,
      message: "denied",
    });
  });
  it("授权未完成时双击也只发起一次录音", async () => {
    const h = harness(),
      auth = deferred<void>();
    vi.mocked(h.deps.authorizeRecord).mockReturnValue(auth.promise);
    const first = h.platform.record(),
      second = h.platform.record();
    auth.resolve();
    await Promise.resolve();
    h.done.resolve({ ...file("recording.mp3"), durationMs: 1000 });
    expect(await first).toEqual({ ...file("recording.mp3"), durationMs: 1000 });
    expect(await second).toBeNull();
    expect(h.deps.authorizeRecord).toHaveBeenCalledTimes(1);
    expect(h.deps.record).toHaveBeenCalledTimes(1);
  });
  it("授权等待中切scope不打开录音", async () => {
    const h = harness(),
      auth = deferred<void>();
    vi.mocked(h.deps.authorizeRecord).mockReturnValue(auth.promise);
    const work = h.platform.record();
    h.change();
    auth.resolve();
    expect(await work).toBeNull();
    expect(h.deps.record).not.toHaveBeenCalled();
  });
  it.each([0, -1, 300001, undefined])("录音时长%s不能提交", async (durationMs) => {
    const h = harness(),
      work = h.platform.record();
    await Promise.resolve();
    h.done.resolve({ ...file("recording.mp3"), durationMs });
    expect(await work).toBeNull();
    expect(h.platform.snapshot().recording).toBe(false);
    expect(h.platform.snapshot().message).toMatch(/录音/u);
  });
  it("最长录音有效；stop只是请求真实结束，不提前返回文件", async () => {
    const h = harness(),
      work = h.platform.record(),
      returned = vi.fn();
    void work.then(returned);
    await Promise.resolve();
    h.platform.stopRecording();
    await Promise.resolve();
    expect(h.stopRecording).toHaveBeenCalledTimes(1);
    expect(returned).not.toHaveBeenCalled();
    h.done.resolve({ ...file("recording.mp3"), durationMs: 300000 });
    expect(await work).toEqual({ ...file("recording.mp3"), durationMs: 300000 });
  });
  it.each(["reset", "dispose"] as const)(
    "%s停止录音和试听，迟到onStop不能交回文件或重写状态",
    async (action) => {
      const h = harness(),
        notify = vi.fn();
      h.platform.subscribe(notify);
      const work = h.platform.record();
      await Promise.resolve();
      h.platform.listen(file("preview.mp3"));
      h.platform[action]();
      const notifications = notify.mock.calls.length;
      h.done.resolve({ ...file("late.mp3"), durationMs: 1000 });
      expect(await work).toBeNull();
      expect(h.stopRecording).toHaveBeenCalledTimes(1);
      expect(h.stopPlayer).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(notifications);
      if (action === "reset")
        expect(h.platform.snapshot()).toEqual({
          recording: false,
          listening: false,
          message: null,
        });
    },
  );
  it("reset后等待旧录音实际结束，再开始新录音", async () => {
    const h = harness(),
      second = deferred<SelectedFile>();
    const old = h.platform.record();
    await Promise.resolve();
    h.platform.reset();
    vi.mocked(h.deps.record).mockReturnValue({ done: second.promise, stop: vi.fn() });
    expect(await h.platform.record()).toBeNull();
    h.done.resolve({ ...file("late.mp3"), durationMs: 1000 });
    expect(await old).toBeNull();
    const fresh = h.platform.record();
    await Promise.resolve();
    expect(h.platform.snapshot().recording).toBe(true);
    second.resolve({ ...file("fresh.mp3"), durationMs: 500 });
    expect(await fresh).toMatchObject({ name: "fresh.mp3" });
  });
  it("试听单持有，错误销毁；旧epoch错误不改新状态", () => {
    const h = harness();
    let onError = () => {};
    vi.mocked(h.deps.play).mockImplementation((_file, failed) => {
      onError = failed;
      return { stop: h.stopPlayer };
    });
    h.platform.listen(file());
    h.platform.listen(file());
    expect(h.stopPlayer).toHaveBeenCalledTimes(1);
    h.platform.listen(file());
    onError();
    expect(h.stopPlayer).toHaveBeenCalledTimes(2);
    expect(h.platform.snapshot().message).toMatch(/试听/u);
    h.platform.reset();
    const fresh = h.platform.snapshot();
    onError();
    expect(h.platform.snapshot()).toEqual(fresh);
  });
});

describe("原生适配器真实参数与进程内录音持有者", () => {
  it("媒体保留元数据；文档/音频只使用服务端支持的聊天扩展名", async () => {
    vi.stubEnv("TARO_ENV", "weapp");
    let current = true;
    native.chooseMedia.mockResolvedValue({ tempFiles: [{ tempFilePath: "photo.png", size: 8 }] });
    native.getImageInfo.mockResolvedValue({ type: "png", width: 20, height: 30 });
    native.chooseMessageFile.mockResolvedValue({
      tempFiles: [{ path: "chat.pdf", name: "chat.pdf", size: 9 }],
    });
    const p = createNativeAssetUploadPlatform(() => current);
    expect(await p.choose("image", 3)).toEqual([
      { path: "photo.png", name: "upload.png", size: 8, width: 20, height: 30, durationMs: 0 },
    ]);
    expect(native.chooseMedia).toHaveBeenLastCalledWith({
      count: 3,
      mediaType: ["image"],
      sizeType: ["original"],
      maxDuration: 60,
    });
    await p.choose("document", 1);
    expect(native.chooseMessageFile).toHaveBeenLastCalledWith({
      count: 1,
      type: "file",
      extension: ["pdf", "docx", "txt"],
    });
    await p.choose("audio", 1);
    expect(native.chooseMessageFile).toHaveBeenLastCalledWith({
      count: 1,
      type: "file",
      extension: ["mp3", "m4a", "wav", "aac"],
    });
    const info = deferred<{ type: string; width: number; height: number }>();
    native.getImageInfo.mockReturnValueOnce(info.promise);
    const late = p.choose("image", 1);
    await Promise.resolve();
    await Promise.resolve();
    current = false;
    info.resolve({ type: "png", width: 1, height: 1 });
    expect(await late).toEqual([]);
    p.dispose();
  });
  it("H5拒绝聊天文件与录音能力，不把替身当原生能力", async () => {
    vi.stubEnv("TARO_ENV", "h5");
    const p = createNativeAssetUploadPlatform(() => true);
    await expect(p.choose("document", 1)).rejects.toThrow(/微信/u);
    expect(await p.record()).toBeNull();
    expect(p.snapshot().message).toMatch(/微信/u);
    p.dispose();
  });
  it("所有原生入口经privacy；拒绝后不调用媒体选择", async () => {
    const before = native.chooseMedia.mock.calls.length;
    native.privacy.mockResolvedValueOnce({ ok: false, value: undefined });
    const p = createNativeAssetUploadPlatform(() => true);
    await expect(p.choose("image", 1)).rejects.toThrow(/隐私/u);
    expect(native.chooseMedia).toHaveBeenCalledTimes(before);
    p.dispose();
  });
  it("录音监听只绑定一次；停止后等真实onStop释放旧holder；迟到文件丢弃且试听destroy", async () => {
    vi.stubEnv("TARO_ENV", "weapp");
    const first = createNativeAssetUploadPlatform(() => true);
    const pending = first.record();
    for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(native.authorize).toHaveBeenLastCalledWith({ scope: "scope.record" });
    expect(native.start).toHaveBeenLastCalledWith({
      duration: 300000,
      format: "mp3",
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
    });
    first.listen(file("preview.mp3"));
    first.dispose();
    expect(native.destroy).toHaveBeenCalledTimes(1);
    const second = createNativeAssetUploadPlatform(() => true);
    expect(await second.record()).toBeNull();
    expect(second.snapshot().message).toMatch(/上一段/u);
    const onStop = native.onStop.mock.calls[0]![0] as (value: {
      tempFilePath: string;
      fileSize: number;
      duration: number;
    }) => void;
    onStop({ tempFilePath: "late.mp3", fileSize: 9, duration: 1000 });
    expect(await pending).toBeNull();
    const fresh = second.record();
    for (let n = 0; n < 8; n++) await Promise.resolve();
    onStop({ tempFilePath: "fresh.mp3", fileSize: 10, duration: 500 });
    expect(await fresh).toMatchObject({ path: "fresh.mp3", durationMs: 500 });
    expect(native.onStop).toHaveBeenCalledTimes(1);
    expect(native.onError).toHaveBeenCalledTimes(1);
    expect(native.stop).toHaveBeenCalled();
    second.dispose();
  });
});
