import type * as ServiceExports from "@liyoxi/services";
import { beforeEach, expect, it, vi } from "vitest";
import { runLegacySnapshotRecovery } from "../src/cli/legacy-snapshot-recovery-command.js";
const state = vi.hoisted(() => ({
  create: vi.fn(),
  recover: vi.fn(),
  resolve: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@liyoxi/services", async (original) => {
  const real = await original<typeof ServiceExports>();
  return {
    ...real,
    loadEnv: (source: Record<string, string>) => ({ APP_ENV: source.APP_ENV }),
    createRuntime: state.create,
    recoverLegacyDailySnapshot: state.recover,
    resolveLegacyRecoveryFindings: state.resolve,
  };
});
const sourceSha = "a".repeat(40),
  event = "01a208c1-2019-743b-bef2-a9759ad59412";
const args = [
  "--event-id",
  event,
  "--authorizing-staff-id",
  "11111111-1111-4111-8111-111111111111",
  "--operator",
  "test operator",
  "--reason",
  "approved recovery",
  "--source-sha",
  sourceSha,
];
beforeEach(() => {
  vi.clearAllMocks();
  state.create.mockReturnValue({
    tx: { run: (fn: (tx: object) => unknown) => fn({}) },
    clock: { now: () => new Date("2040-01-01") },
    close: state.close,
  });
  state.recover.mockResolvedValue({
    status: "preview",
    eventId: event,
    evidenceHash: "b".repeat(64),
    payloadHash: "c".repeat(64),
  });
});
async function run(argv = args, env = "stg", version = `sha-${sourceSha.slice(0, 12)}`) {
  const out: string[] = [],
    err: string[] = [];
  const code = await runLegacySnapshotRecovery({
    argv,
    source: { APP_ENV: env },
    version,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out, err };
}
it.each([
  [[], "stg", `sha-${sourceSha.slice(0, 12)}`],
  [args, "prod", `sha-${sourceSha.slice(0, 12)}`],
  [args, "stg", "sha-bbbbbbbbbbbb"],
  [[...args, "--apply"], "stg", `sha-${sourceSha.slice(0, 12)}`],
  [[...args, "--event-id", event], "stg", `sha-${sourceSha.slice(0, 12)}`],
  [
    args.map((v) => (v === event ? "22222222-2222-4222-8222-222222222222" : v)),
    "stg",
    `sha-${sourceSha.slice(0, 12)}`,
  ],
] as const)("参数/范围/版本/生产环境拦截在创建运行时之前", async (argv, env, version) => {
  expect((await run([...argv], env, version)).code).toBe(1);
  expect(state.create).not.toHaveBeenCalled();
  expect(state.recover).not.toHaveBeenCalled();
});
it("默认预览，带明确指纹才传实际追加；总是关闭运行时", async () => {
  expect((await run()).code).toBe(0);
  expect(state.recover.mock.calls[0]?.[1]).toMatchObject({ apply: false, eventId: event });
  const applied = await run([
    ...args,
    "--apply",
    "--evidence-hash",
    "b".repeat(64),
    "--payload-hash",
    "c".repeat(64),
  ]);
  expect(applied.code).toBe(0);
  expect(state.recover.mock.calls[1]?.[1]).toMatchObject({
    apply: true,
    evidenceHash: "b".repeat(64),
  });
  expect(state.close).toHaveBeenCalledTimes(2);
});
it("异常仅输出受限错误码，私有证据与配置不泄漏", async () => {
  state.recover.mockRejectedValue(new Error("private evidence and credentials"));
  const result = await run();
  expect(result.code).toBe(2);
  expect(result.err).toEqual(["LEGACY_RECOVERY_FAILED"]);
  expect(result.out).toEqual([]);
  expect(state.close).toHaveBeenCalledOnce();
});

it("违规收尾必须显式 apply 和两个指纹，调用独立复核入口", async () => {
  expect((await run([...args, "--resolve-history-findings"])).code).toBe(1);
  expect(state.create).not.toHaveBeenCalled();
  const result = await run([
    ...args,
    "--resolve-history-findings",
    "--apply",
    "--evidence-hash",
    "b".repeat(64),
    "--payload-hash",
    "c".repeat(64),
  ]);
  expect(result.code).toBe(0);
  expect(state.resolve).toHaveBeenCalledOnce();
  expect(state.recover).not.toHaveBeenCalled();
  expect(state.close).toHaveBeenCalledOnce();
});
