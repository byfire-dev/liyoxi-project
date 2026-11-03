import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
  digest: "a".repeat(40),
  api: vi.fn(),
  report: vi.fn(async () => undefined),
  refreshFailure: false,
  cancel: vi.fn(),
  quarantine: vi.fn(),
  instances: [] as unknown[],
}));
vi.mock("@tarojs/taro", () => ({
  default: {
    getStorageSync: (key: string) => mock.storage.get(key),
    setStorageSync: (key: string, value: unknown) =>
      mock.storage.set(key, JSON.parse(JSON.stringify(value))),
    removeStorageSync: (key: string) => mock.storage.delete(key),
    setKeepScreenOn: ({ complete }: { complete: () => void }) => complete(),
    getFileInfo: ({ success }: { success: (value: object) => void }) =>
      success({ size: 150_000_000, digest: mock.digest }),
  },
}));
vi.mock("../src/lib/api", () => ({
  api: mock.api,
  getProbeMode: async () => "real",
  baseUrl: "https://probe.example.invalid",
  quarantine: mock.quarantine,
  report: mock.report,
  ensurePrivacy: async () => undefined,
  newId: () => "generated-file-token",
  ProbeError: class extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
  errorCode: (error: { code?: string }) => error.code || "PLATFORM_ERROR",
}));
vi.mock("cos-wx-sdk-v5", () => ({
  default: class {
    event?: (request: object) => void;
    constructor(
      private options: { getAuthorization: (options: object, callback: () => void) => void },
    ) {
      mock.instances.push(this);
    }
    on(_name: string, callback: (request: object) => void) {
      this.event = callback;
    }
    multipartListPart(_params: object, callback: (error: unknown, data: object) => void) {
      callback(null, { Part: [{ PartNumber: 1 }, { PartNumber: 2 }] });
    }
    cancelTask = mock.cancel;
    sliceUploadFile(
      params: { onTaskReady: (id: string) => void },
      callback: (error: unknown) => void,
    ) {
      params.onTaskReady("fake-task");
      this.options.getAuthorization({}, () => {
        if (mock.refreshFailure) {
          this.options.getAuthorization({}, () => callback(null));
          return;
        }
        this.multipartListPart({ UploadId: "private-upload-id" }, () => {
          this.event?.({ method: "PUT", qs: { uploadId: "private-upload-id", partNumber: "3" } });
          callback(null);
        });
      });
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.storage.clear();
  mock.instances.length = 0;
  mock.refreshFailure = false;
  mock.digest = "a".repeat(40);
  mock.api.mockImplementation(async (path: string) => {
    if (path === "/uploads") return { fileId: "file-id", key: "incoming/file-id/source.mp4" };
    if (path.endsWith("/credentials"))
      return {
        TmpSecretId: "temporary-id",
        TmpSecretKey: "temporary-key",
        SecurityToken: "temporary-token",
        StartTime: 1,
        ExpiredTime: 1801,
        Bucket: "example",
        Region: "region",
        Key: "incoming/file-id/source.mp4",
      };
    return { verified: true, size: 150_000_000 };
  });
});

describe("upload resume observations with fake platform", () => {
  it("reuses clientToken after path changes and records confirmed parts without identifiers or credentials", async () => {
    const upload = await import("../src/lib/upload");
    const update = vi.fn();
    await upload.upload({ path: "/temp/first.mp4", size: 150_000_000 }, "baseline", update);
    await upload.upload(
      { path: "/temp/reselected.mp4", size: 150_000_000 },
      "process_reselect",
      update,
    );
    const registrations = mock.api.mock.calls.filter(([path]) => path === "/uploads");
    expect(registrations[0][2].clientToken).toBe(registrations[1][2].clientToken);
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        matched: true,
        completedParts: 2,
        sentParts: 1,
        retransmittedParts: 0,
      }),
    );
    expect(mock.report).toHaveBeenCalledWith(
      expect.objectContaining({ completedParts: 2, sentParts: 1, result: "success" }),
      "real",
    );
    expect(JSON.stringify(mock.report.mock.calls)).not.toMatch(
      /private-upload-id|temporary-key|temporary-token/,
    );
  });
  it("fails and settles instead of hanging when the SDK refresh credential callback cannot authenticate", async () => {
    mock.refreshFailure = true;
    let credentialCalls = 0;
    const implementation = mock.api.getMockImplementation()!;
    mock.api.mockImplementation(async (path: string, ...args: unknown[]) => {
      if (path.endsWith("/credentials") && ++credentialCalls > 1) throw new Error("not exposed");
      return implementation(path, ...args);
    });
    const upload = await import("../src/lib/upload");
    await upload.upload({ path: "/temp/first.mp4", size: 150_000_000 }, "baseline", vi.fn());
    expect(mock.cancel).toHaveBeenCalledWith("fake-task");
    expect(mock.report).toHaveBeenCalledWith(
      expect.objectContaining({ result: "failure", errorCode: "CREDENTIALS_UNAVAILABLE" }),
      "real",
    );
    expect(mock.storage.has("lyx_probe_upload_pending")).toBe(false);
  });
});

it.each([
  {},
  { probeMode: "fake", serviceUrl: "https://probe.example.invalid" },
  { probeMode: "real", serviceUrl: "https://different.example.invalid" },
])("quarantines an interrupted upload whose origin is unknown or differs: %j", async (origin) => {
  const pending = {
    ...origin,
    runId: "old-run",
    started: Date.now(),
    size: 150_000_000,
    scenario: "process_reselect",
    totalParts: 36,
  };
  mock.storage.set("lyx_probe_upload_pending", pending);
  const upload = await import("../src/lib/upload");
  await upload.recoverUpload();
  expect(mock.quarantine).toHaveBeenCalledWith("upload_pending", pending);
  expect(mock.report).not.toHaveBeenCalled();
  expect(mock.api).not.toHaveBeenCalled();
  expect(mock.storage.has("lyx_probe_upload_pending")).toBe(false);
});
