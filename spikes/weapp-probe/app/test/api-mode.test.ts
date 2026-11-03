import { beforeEach, expect, it, vi } from "vitest";
import { createProbe } from "../../server/src/app.ts";
import { createFakeProvider } from "../../server/src/provider.ts";
import { summarize } from "../../server/src/report.ts";
import type { RecordRow } from "../../server/src/records.ts";

const mock = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
  request: vi.fn(),
  login: vi.fn(async () => ({ code: "real-device-code" })),
}));
vi.mock("@tarojs/taro", () => ({
  default: {
    getStorageSync: (key: string) => mock.storage.get(key),
    setStorageSync: (key: string, value: unknown) =>
      mock.storage.set(key, JSON.parse(JSON.stringify(value))),
    removeStorageSync: (key: string) => mock.storage.delete(key),
    getSystemInfoSync: () => ({ model: "test-phone", system: "test-os", SDKVersion: "3.8.0" }),
    getNetworkType: async () => ({ networkType: "wifi" }),
    request: mock.request,
    login: mock.login,
  },
}));
const baseUrl = "https://probe.example.invalid";
const attempt = {
  item: "V7" as const,
  scenario: "offline_fake",
  sizeBytes: 30_000_000,
  durationMs: 100,
  result: "success" as const,
  errorCode: "",
};
let mode: "fake" | "real";
let offline: boolean;
let realRows: RecordRow[];
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.storage.clear();
  vi.stubGlobal("__PROBE_BASE_URL__", baseUrl);
  mode = "fake";
  offline = false;
  realRows = [];
  const apps = Object.fromEntries(
    (["fake", "real"] as const).map((probeMode) => [
      probeMode,
      createProbe(
        { mode: probeMode, port: 4310, portalOrigin: "https://portal.example.invalid" },
        createFakeProvider(),
        (row) => {
          if (probeMode === "real") realRows.push({ ...row, recordedAt: "2026-11-04T00:00:00Z" });
        },
      ),
    ]),
  );
  mock.request.mockImplementation(
    async (options: {
      url: string;
      method: string;
      data?: object;
      header: Record<string, string>;
    }) => {
      const url = new URL(options.url);
      if (offline && url.pathname.endsWith("/attempts")) throw new Error("offline");
      const response = await apps[mode]!.request(url.pathname + url.search, {
        method: options.method,
        headers: options.header,
        ...(options.data ? { body: JSON.stringify(options.data) } : {}),
      });
      return { statusCode: response.status, data: await response.json() };
    },
  );
});
it("quarantines fake offline successes after reconnecting to real, so real summary only contains real attempts", async () => {
  const api = await import("../src/lib/api");
  await api.getProbeMode();
  offline = true;
  await api.report(attempt, "fake");
  expect(api.pendingCount()).toBe(1);
  expect(mock.storage.get("lyx_probe_attempts")).toEqual([
    expect.objectContaining({ probeMode: "fake", serviceUrl: baseUrl }),
  ]);
  mode = "real";
  offline = false;
  await api.flushAttempts();
  expect(api.pendingCount()).toBe(0);
  expect(api.quarantinedCount()).toBe(1);
  expect(realRows).toHaveLength(0);
  await api.report({ ...attempt, scenario: "real_download" }, "real");
  expect(realRows).toHaveLength(1);
  expect(realRows[0]!.probeMode).toBe("real");
  const summary = summarize(realRows, "real");
  expect(summary).toContain("real_download");
  expect(summary).not.toContain("offline_fake");
});
it("does not relabel legacy records or records from another service as real", async () => {
  const api = await import("../src/lib/api");
  mode = "real";
  mock.storage.set("lyx_probe_attempts", [
    { ...attempt, attemptId: "legacy" },
    {
      ...attempt,
      attemptId: "foreign",
      probeMode: "real",
      serviceUrl: "https://different.example.invalid",
    },
  ]);
  await api.flushAttempts();
  expect(realRows).toHaveLength(0);
  expect(api.pendingCount()).toBe(0);
  expect(api.quarantinedCount()).toBe(2);
  const quarantine = mock.storage.get("lyx_probe_quarantined");
  expect(quarantine).toEqual([
    expect.objectContaining({ value: expect.objectContaining({ attemptId: "legacy" }) }),
    expect.objectContaining({
      value: expect.objectContaining({
        probeMode: "real",
        serviceUrl: "https://different.example.invalid",
      }),
    }),
  ]);
});
it("an unconnected or invalid server mode never defaults to real", async () => {
  const api = await import("../src/lib/api");
  await api.report(attempt);
  expect(api.quarantinedCount()).toBe(1);
  expect(mock.request).not.toHaveBeenCalled();
  mock.request.mockResolvedValue({ statusCode: 200, data: { mode: "unknown" } });
  await expect(api.getProbeMode(true)).rejects.toMatchObject({ code: "PROBE_MODE_INVALID" });
  expect(mock.login).not.toHaveBeenCalled();
  expect(realRows).toHaveLength(0);
});
