import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock, Env, TxRunner } from "../kernel/index.js";
import type { Media } from "../media/index.js";
import { createSampleWatermarkActions } from "./sample-watermark-actions.js";

const mocks = vi.hoisted(() => ({
  staff: vi.fn(),
  permission: vi.fn(),
  target: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../staff/index.js", () => ({ loadCliStaffContext: mocks.staff }));
vi.mock("../authz/index.js", () => ({ assertPermission: mocks.permission }));
vi.mock("../delivery/index.js", () => ({ lockCurrentSampleWatermarkTarget: mocks.target }));
vi.mock("../audit/index.js", () => ({ record: mocks.audit }));
const staffId = "01a17d2e-4ebd-7414-9e7b-fcd0e0147645";
const sampleId = "01a17d23-4200-774d-b851-0984a97943b9";
const fileId = "01a17d22-9164-726d-9b1d-da2be360c073";
const jobId = "01a17d0a-796f-73bc-9213-242238377be2";
const input = { staffId, sampleId, note: "本地演示补排真实水印" };
function fixture(
  appEnv: Env["APP_ENV"] = "test",
  databaseUrl = "postgres://local@127.0.0.1:5432/lyx_test",
) {
  const inner = {},
    run = vi.fn(async (action: (tx: unknown) => Promise<unknown>) => action(inner));
  const ensure = vi.fn(async () => jobId),
    wake = vi.fn(async () => {});
  const env = {
    APP_ENV: appEnv,
    DATABASE_URL: databaseUrl,
    MEDIA_PRODUCTION: {
      mode: "local_sample_watermark",
      workDir: "/work",
      socketPath: "/work/.sock/mediatool.sock",
    },
  } as Env;
  return {
    env,
    inner,
    run,
    ensure,
    wake,
    actions: () =>
      createSampleWatermarkActions({
        env,
        tx: { run } as unknown as TxRunner,
        clock: { now: () => new Date("2026-10-27T12:00:00Z") } as Clock,
        media: { ensureSampleWatermark: ensure, jobs: { wake } } as unknown as Media,
      }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.staff.mockResolvedValue({ staff: { id: staffId, roleKey: "super_admin" } });
  mocks.permission.mockReturnValue(undefined);
  mocks.target.mockResolvedValue({ fileId, ticketId: "ticket", versionNo: 1 });
  mocks.audit.mockResolvedValue(undefined);
});
describe("本地样片水印受限CLI服务", () => {
  it("读取真实员工、当前质检样片并审计后才唤醒；不调用QC或source写接口", async () => {
    const f = fixture();
    expect(await f.actions().runCli(input)).toEqual({ sampleId, fileId, jobId });
    expect(mocks.staff).toHaveBeenCalledWith(f.inner, staffId);
    expect(mocks.permission.mock.calls.map((call) => call[1])).toEqual([
      "media.job.retry",
      "delivery.sample.push",
    ]);
    expect(mocks.target).toHaveBeenCalledWith(f.inner, sampleId, expect.any(Object));
    expect(f.ensure).toHaveBeenCalledWith(f.inner, fileId);
    expect(mocks.audit).toHaveBeenCalledWith(
      f.inner,
      expect.objectContaining({ type: "staff", id: staffId, client: "cli" }),
      expect.objectContaining({ jobName: "cli.sample.watermark" }),
      expect.objectContaining({
        action: "media.sample.watermark_enqueue",
        target: { type: "sample", id: sampleId },
        reason: { code: "other", text: input.note },
      }),
    );
    expect(f.wake).toHaveBeenCalledWith(jobId);
    expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(
      f.wake.mock.invocationCallOrder[0]!,
    );
  });
  it.each(["stg", "prod"] as const)("%s在读员工/事务前拒绝", async (appEnv) => {
    const f = fixture(appEnv);
    await expect(f.actions().runCli(input)).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(["postgres://local@db.example:5432/liyoxi", "postgres://local@192.168.1.2:5432/liyoxi"])(
    "拒绝非本机库 %s",
    async (url) => {
      const f = fixture("local", url);
      await expect(f.actions().runCli(input)).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
      expect(f.run).not.toHaveBeenCalled();
    },
  );
  it("probe_only不能借CLI启用水印", async () => {
    const f = fixture();
    Object.assign(f.env, {
      MEDIA_PRODUCTION: {
        mode: "probe_only",
        workDir: "/work",
        socketPath: "/work/.sock/mediatool.sock",
      },
    });
    await expect(f.actions().runCli(input)).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("当前性/权限拒绝或审计失败均不唤醒", async () => {
    const f = fixture();
    mocks.target.mockRejectedValueOnce(new Error("stale"));
    await expect(f.actions().runCli(input)).rejects.toThrow("stale");
    expect(f.ensure).not.toHaveBeenCalled();
    mocks.audit.mockRejectedValueOnce(new Error("audit failed"));
    await expect(f.actions().runCli(input)).rejects.toThrow("audit failed");
    expect(f.wake).not.toHaveBeenCalled();
  });
});
