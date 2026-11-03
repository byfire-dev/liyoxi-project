import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => {
  const storage = new Map<string, unknown>();
  const requests: {
    options: {
      filePath?: string;
      success: (result: object) => void;
      fail: (error: object) => void;
    };
    abort: () => void;
  }[] = [];
  const unlink = vi.fn(({ success }: { success: () => void }) => success());
  return {
    storage,
    requests,
    unlink,
    api: vi.fn(async () => ({
      url: "https://fixture.invalid/video.mp4",
      size: 30_000_000,
      expiresAt: "2099-01-01T00:00:00Z",
      timeoutMs: 300000,
    })),
    fake: vi.fn(async () => false),
    report: vi.fn(async () => undefined),
    album: vi.fn(async () => undefined),
    privacy: vi.fn(async () => undefined),
  };
});
vi.mock("@tarojs/taro", () => ({
  default: {
    env: { USER_DATA_PATH: "/user" },
    getStorageSync: (key: string) => mock.storage.get(key),
    setStorageSync: (key: string, value: unknown) =>
      mock.storage.set(key, JSON.parse(JSON.stringify(value))),
    getFileSystemManager: () => ({ unlink: mock.unlink }),
    getFileInfo: ({ success }: { success: (value: object) => void }) =>
      success({ size: 30_000_000, digest: "digest" }),
    getSetting: async () => ({ authSetting: { "scope.writePhotosAlbum": true } }),
    authorize: async () => undefined,
    setKeepScreenOn: ({ complete }: { complete: () => void }) => complete(),
    saveVideoToPhotosAlbum: mock.album,
    downloadFile: (options: {
      filePath?: string;
      success: (result: object) => void;
      fail: (error: object) => void;
    }) => {
      const request = { options, abort: () => options.fail({ errMsg: "downloadFile:fail abort" }) };
      mock.requests.push(request);
      return request;
    },
  },
}));
vi.mock("../src/lib/api", () => ({
  api: mock.api,
  isFake: mock.fake,
  report: mock.report,
  ensurePrivacy: mock.privacy,
  newId: () => "test-run",
  ProbeError: class extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
  errorCode: (error: { code?: string; errMsg?: string }) =>
    error.code || (error.errMsg?.includes("abort") ? "INTERRUPTED" : "PLATFORM_ERROR"),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.storage.clear();
  mock.requests.length = 0;
  mock.fake.mockResolvedValue(false);
  mock.album.mockResolvedValue(undefined);
  mock.privacy.mockResolvedValue(undefined);
  mock.unlink.mockImplementation(({ success }) => success());
});
function finish(index: number) {
  mock.requests[index].options.success({ statusCode: 200, tempFilePath: `/temp/${index}.mp4` });
}

describe("download lifecycle with fake platform", () => {
  it("limits downloads to two, uses temp paths and resumes without saving finished episodes twice", async () => {
    const download = await import("../src/lib/download");
    await download.startDownloads(30, 3, "temp", "background_resume");
    await vi.waitFor(() => expect(mock.requests).toHaveLength(2));
    expect(mock.requests.every((request) => !("filePath" in request.options))).toBe(true);
    finish(0);
    await vi.waitFor(() => expect(mock.requests).toHaveLength(3));
    download.pauseDownloads();
    await vi.waitFor(() => expect(mock.report).toHaveBeenCalledTimes(3));
    expect(mock.album).toHaveBeenCalledTimes(1);
    download.resumeDownloads();
    await vi.waitFor(() => expect(mock.requests).toHaveLength(5));
    finish(3);
    finish(4);
    await vi.waitFor(() => expect(mock.report).toHaveBeenCalledTimes(5));
    expect(mock.album).toHaveBeenCalledTimes(3);
    expect(mock.unlink).toHaveBeenCalledTimes(3);
    expect(download.residualFiles()).toBe(0);
    const queue = mock.storage.get("lyx_probe_download_queue") as { jobs: { status: string }[] };
    expect(queue.jobs.map((job) => job.status)).toEqual(["saved", "saved", "saved"]);
  });
  it("cleans the temp file even when saving to the album fails", async () => {
    mock.album.mockRejectedValue({ errMsg: "saveVideoToPhotosAlbum:fail" });
    const download = await import("../src/lib/download");
    await download.startDownloads(30, 1, "temp", "low_storage");
    await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
    finish(0);
    await vi.waitFor(() => expect(mock.report).toHaveBeenCalledTimes(1));
    expect(mock.unlink).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/temp/0.mp4" }));
    expect(mock.report).toHaveBeenCalledWith(
      expect.objectContaining({ result: "failure", phase: "saving" }),
    );
    expect(download.residualFiles()).toBe(0);
  });
  it("removes a partial user_dir path after a download error", async () => {
    const download = await import("../src/lib/download");
    await download.startDownloads(30, 1, "user_dir", "low_storage");
    await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
    expect(mock.requests[0].options.filePath).toBe("/user/lyx-probe-test-run-1.mp4");
    mock.requests[0].options.fail({ errMsg: "downloadFile:fail" });
    await vi.waitFor(() => expect(mock.report).toHaveBeenCalledTimes(1));
    expect(mock.unlink).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/user/lyx-probe-test-run-1.mp4" }),
    );
    expect(mock.album).not.toHaveBeenCalled();
  });
  it("recovers interrupted downloads but keeps an unknown album result for manual review", async () => {
    mock.storage.set("lyx_probe_download_queue", {
      runId: "old-run",
      sizeMb: 30,
      mode: "temp",
      scenario: "continuous_80",
      paused: false,
      jobs: [
        { index: 1, status: "saved", error: "", attempt: 1 },
        { index: 2, status: "downloading", error: "", attempt: 1, started: Date.now() },
        { index: 3, status: "saving", error: "", attempt: 1, started: Date.now() },
      ],
    });
    mock.storage.set("lyx_probe_download_files", ["/temp/interrupted.mp4"]);
    const download = await import("../src/lib/download");
    await download.initializeDownloads();
    expect(mock.report).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "SAVE_RESULT_UNKNOWN", index: 3 }),
    );
    expect(download.residualFiles()).toBe(0);
    download.retryFailedDownloads();
    expect(mock.requests).toHaveLength(0);
    download.resumeDownloads();
    await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
    finish(0);
    await vi.waitFor(() => expect(mock.report).toHaveBeenCalledTimes(3));
    expect(mock.album).toHaveBeenCalledTimes(1);
    expect(mock.requests).toHaveLength(1);
    await download.resolveUnknownDownload(3, true);
    expect(mock.report).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "album_manually_confirmed", index: 3 }),
    );
    expect(mock.album).toHaveBeenCalledTimes(1);
  });
  it("retries an unknown save only after that episode is confirmed absent from the album", async () => {
    mock.storage.set("lyx_probe_download_queue", {
      runId: "old-run",
      sizeMb: 30,
      mode: "temp",
      scenario: "continuous_80",
      paused: false,
      jobs: [{ index: 1, status: "saving", error: "", attempt: 1, started: Date.now() }],
    });
    const download = await import("../src/lib/download");
    await download.initializeDownloads();
    download.retryFailedDownloads();
    expect(mock.requests).toHaveLength(0);
    await download.resolveUnknownDownload(1, false);
    await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
    finish(0);
    await vi.waitFor(() => expect(mock.report).toHaveBeenCalledTimes(3));
    expect(mock.album).toHaveBeenCalledTimes(1);
    expect(mock.report).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "album_retry_confirmed", index: 1 }),
    );
  });
  it("records a preflight permission failure before any download is started", async () => {
    mock.privacy.mockRejectedValue({ code: "PERMISSION_DENIED" });
    const download = await import("../src/lib/download");
    await expect(download.startDownloads(30, 1, "temp", "baseline")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(mock.requests).toHaveLength(0);
    expect(mock.report).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "preflight",
        result: "failure",
        errorCode: "PERMISSION_DENIED",
      }),
    );
  });
  it("fake mode never downloads files or asks for album permission", async () => {
    mock.fake.mockResolvedValue(true);
    const download = await import("../src/lib/download");
    await download.startDownloads(30, 3, "temp", "baseline");
    await vi.waitFor(() => expect(mock.report).toHaveBeenCalledTimes(3));
    expect(mock.requests).toHaveLength(0);
    expect(mock.album).not.toHaveBeenCalled();
    expect(mock.privacy).not.toHaveBeenCalled();
    expect(mock.report).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "fake_endpoints_only" }),
    );
  });
});
