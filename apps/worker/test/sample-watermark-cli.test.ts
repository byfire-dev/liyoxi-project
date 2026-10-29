import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSampleWatermarkCommand } from "../src/cli/sample-watermark-command.js";

const mocks = vi.hoisted(() => ({ env: vi.fn(), runtime: vi.fn(), run: vi.fn(), close: vi.fn() }));
vi.mock("@liyoxi/services", () => ({
  loadEnv: mocks.env,
  createRuntime: mocks.runtime,
  createSampleWatermarkActions: () => ({ runCli: mocks.run }),
  isUuid: (value: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value),
  isAppError: (value: unknown) => value !== null && typeof value === "object" && "error" in value,
}));
const staffId = "01a17d2e-4ebd-7414-9e7b-fcd0e0147645",
  sampleId = "01a17d23-4200-774d-b851-0984a97943b9";
const args = [
  "--database",
  "liyoxi",
  "--staff",
  staffId,
  "--sample-id",
  sampleId,
  "--note",
  "本地演示补排真实水印",
];
async function run(argv = args, signal?: AbortSignal) {
  const out: string[] = [],
    err: string[] = [];
  const code = await runSampleWatermarkCommand({
    argv,
    signal,
    out: (value) => out.push(value),
    err: (value) => err.push(value),
  });
  return { code, out, err };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.mockReturnValue({
    APP_ENV: "local",
    DATABASE_URL: "postgres://local@127.0.0.1:5432/liyoxi",
    MEDIA_PRODUCTION: { mode: "local_sample_watermark" },
  });
  mocks.runtime.mockReturnValue({ close: mocks.close });
  mocks.close.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ sampleId, fileId: "file", jobId: "job" });
});
describe("样片水印本机运维薄壳", () => {
  it("严格单对象/显式数据库/原因校验和预取消均先于加载配置", async () => {
    for (const argv of [
      [],
      [...args, "--staff", staffId],
      [...args, "--all"],
      args.slice(2),
      [...args, "extra"],
      [...args.slice(0, -1), "短"],
    ])
      expect((await run(argv)).code).toBe(1);
    expect((await run(args, AbortSignal.abort())).code).toBe(1);
    expect(mocks.env).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it.each([
    {
      APP_ENV: "prod",
      DATABASE_URL: "postgres://local@127.0.0.1/liyoxi",
      MEDIA_PRODUCTION: { mode: "local_sample_watermark" },
    },
    {
      APP_ENV: "local",
      DATABASE_URL: "postgres://secret@remote.example/liyoxi",
      MEDIA_PRODUCTION: { mode: "local_sample_watermark" },
    },
    {
      APP_ENV: "local",
      DATABASE_URL: "postgres://local@127.0.0.1/another_db",
      MEDIA_PRODUCTION: { mode: "local_sample_watermark" },
    },
    {
      APP_ENV: "local",
      DATABASE_URL: "postgres://local@127.0.0.1/liyoxi",
      MEDIA_PRODUCTION: { mode: "probe_only" },
    },
  ])("拒绝环境/host/数据库/模式不符且不回显配置", async (env) => {
    mocks.env.mockReturnValue(env);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join()).not.toContain("secret");
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it("只传真实staff/sample/reason至正式服务，结果仅输出引用并关闭runtime", async () => {
    expect(await run()).toEqual({
      code: 0,
      out: [JSON.stringify({ sampleId, fileId: "file", jobId: "job" })],
      err: [],
    });
    expect(mocks.run).toHaveBeenCalledWith({ staffId, sampleId, note: args.at(-1) });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("失败输出仅符号，不回显失败载荷并关闭runtime", async () => {
    mocks.run.mockRejectedValue({ error: "STATE_NOT_ALLOWED", details: "private source" });
    expect(await run()).toEqual({ code: 1, out: [], err: ["样片水印补排拒绝：STATE_NOT_ALLOWED"] });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
