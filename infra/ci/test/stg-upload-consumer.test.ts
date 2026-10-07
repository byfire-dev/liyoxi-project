import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadArtifacts } from "../../deploy/weapp-artifact.mjs";
import { uploadRelease } from "../../deploy/upload-release.mjs";
import { makeTempDir, repoRoot } from "./helpers.js";

const source = "a".repeat(40),
  tag = `sha-${source.slice(0, 12)}`;
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const digest = (n: string) => `sha256:${n.repeat(64)}`;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});
function fixture() {
  const tmp = makeTempDir("lyx-upload-consumer-");
  cleanups.push(tmp.cleanup);
  const project = join(tmp.dir, "project");
  mkdirSync(project);
  const manifest = {
    source,
    tag,
    appid: "wx0123456789abcdef",
    apiBaseUrl: "https://api.stg.invalid",
    weappSha256: hash("archive"),
    images: Object.fromEntries(
      ["server", "gateway", "mediatool", "weapp-uploader"].map((name) => [
        name,
        {
          registryDigest: digest("1"),
          amd64ManifestDigest: digest("2"),
          amd64ConfigDigest: digest("3"),
        },
      ]),
    ),
  };
  const record = {
    schemaVersion: 1,
    runId: "0".repeat(32),
    action: "release",
    version: tag,
    previousVersion: null,
    startedAt: "2026-10-07T00:00:00.000Z",
    finishedAt: "2026-10-07T00:00:01.000Z",
    durationMs: 1000,
    result: "success",
    failedStep: null,
    onlineTouched: true,
    runtimeTouched: true,
    rollbackSafe: true,
    reason: "",
    overrideP1: [],
    p1: "unavailable",
    compatibility: "unavailable",
    imageDigests: { server: digest("1"), gateway: digest("1"), mediatool: digest("1") },
    steps: [],
  };
  const raw = JSON.stringify(manifest);
  writeFileSync(join(tmp.dir, "images.json"), raw);
  writeFileSync(join(tmp.dir, "weapp.tar.gz"), "archive");
  writeFileSync(join(project, "app.json"), "{}");
  writeFileSync(join(project, "project.config.json"), JSON.stringify({ appid: manifest.appid }));
  writeFileSync(join(tmp.dir, "release.env"), `# node generated\nLYX_TAG=${tag}\n`);
  writeFileSync(join(tmp.dir, "releases.log"), JSON.stringify(record) + "\n");
  const options = {
    source,
    manifestSha256: hash(raw),
    appid: manifest.appid,
    apiBaseUrl: manifest.apiBaseUrl,
    imageId: digest("3"),
    artifacts: tmp.dir,
    releaseEnv: join(tmp.dir, "release.env"),
    releaseLog: join(tmp.dir, "releases.log"),
    key: "/run/secrets/weapp-upload-private-key",
  };
  return { dir: tmp.dir, manifest, record, raw, options };
}
describe("上传前同源、部署与SDK隔离", () => {
  it.each(["1", "2", "3"])("真实 %s digest事实可到达桩SDK，robot固定1且没有tag调用", async (n) => {
    const f = fixture(),
      sdk = vi.fn(async (_args: string[]) => {});
    expect(await uploadArtifacts({ ...f.options, imageId: digest(n) }, sdk)).toMatchObject({
      status: "uploaded",
      robot: 1,
    });
    expect(sdk).toHaveBeenCalledOnce();
    expect(sdk.mock.calls[0]?.[0]).toEqual([
      "--upload",
      "--project",
      join(f.dir, "project"),
      "--appid",
      f.manifest.appid,
      "--private-key",
      "/run/secrets/weapp-upload-private-key",
      "--version",
      tag,
      "--robot",
      "1",
    ]);
  });
  it.each([
    "manifest",
    "archive",
    "source",
    "appid",
    "api",
    "image",
    "current",
    "failed",
    "partial-log",
    "project",
  ])("%s篡改在微信SDK前拒绝", async (kind) => {
    const f = fixture(),
      sdk = vi.fn(async () => {}),
      options = { ...f.options };
    if (kind === "manifest") writeFileSync(join(f.dir, "images.json"), f.raw + " ");
    if (kind === "archive") writeFileSync(join(f.dir, "weapp.tar.gz"), "tampered");
    if (kind === "source") options.source = "b".repeat(40);
    if (kind === "appid") options.appid = "wx1111111111111111";
    if (kind === "api") options.apiBaseUrl = "https://other.invalid";
    if (kind === "image") options.imageId = digest("9");
    if (kind === "current") writeFileSync(options.releaseEnv, "LYX_TAG=sha-bbbbbbbbbbbb\n");
    if (kind === "failed")
      writeFileSync(
        options.releaseLog,
        JSON.stringify({ ...f.record, result: "failure", failedStep: "verify-db" }) + "\n",
      );
    if (kind === "partial-log") writeFileSync(options.releaseLog, JSON.stringify(f.record));
    if (kind === "project")
      writeFileSync(
        join(f.dir, "project/project.config.json"),
        JSON.stringify({ appid: "touristappid" }),
      );
    await expect(uploadArtifacts(options, sdk)).rejects.toThrow();
    expect(sdk).not.toHaveBeenCalled();
  });
  it("CI上传缺省跳过；启用后只传固定source+同run manifest hash，节点跳过也保留摘要", () => {
    const f = fixture(),
      channel = vi.fn(() => ({
        status: 0,
        stdout:
          'LYX_WEAPP_UPLOAD={"status":"skipped","reason":"disabled_or_bucket_unconfigured"}\n',
        stderr: "",
      }));
    expect(uploadRelease({}, channel)).toMatchObject({ status: "skipped" });
    expect(channel).not.toHaveBeenCalled();
    mkdirSync(join(f.dir, "images-release"));
    writeFileSync(join(f.dir, "images-release/images.json"), f.raw);
    const env = { RUNNER_TEMP: f.dir, EXPECTED_SHA: source, STG_WEAPP_UPLOAD_ENABLED: "true" };
    expect(uploadRelease(env, channel)).toMatchObject({ status: "skipped", source });
    expect(channel).toHaveBeenCalledWith("weapp-upload", [source, hash(f.raw)]);
    expect(() => uploadRelease({ ...env, STG_FREEZE: "true" }, channel)).toThrow();
    expect(() => uploadRelease({ ...env, EXPECTED_SHA: "b".repeat(40) }, channel)).toThrow();
    expect(channel).toHaveBeenCalledTimes(1);
  });
  it("真bash协议拒绝路径/URL/夹带命令；未配置桶skip0，启用缺能力拒绝", () => {
    const tmp = makeTempDir("lyx-upload-bash-");
    cleanups.push(tmp.cleanup);
    const script = join(repoRoot, "infra/deploy/node-step.sh");
    const env = {
      ...process.env,
      LYX_SRC: repoRoot,
      LYX_NODE_HOME: tmp.dir,
      LYX_NODE_SUPERVISOR: "compose",
      LYX_WEAPP_UPLOAD_ENABLED: "true",
      WEAPP_APPID: "wx0123456789abcdef",
      WEAPP_API_BASE_URL: "https://api.stg.invalid",
    };
    const run = (args: string[], extra = {}) =>
      spawnSync("bash", [script, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
    expect(run(["weapp-upload", source, "0".repeat(64)]).stdout).toContain('"status":"skipped"');
    for (const bad of ["../key", "https://other.invalid", source + ";id", "-oProxyCommand=id"])
      expect(run(["weapp-upload", bad, "0".repeat(64)]).status).toBe(2);
    expect(run([], { SSH_ORIGINAL_COMMAND: `weapp-upload ${source} bad;id` }).status).toBe(2);
    writeFileSync(join(tmp.dir, "release.env"), `LYX_TAG=${tag}\n`);
    const failed = run(["weapp-upload", source, "0".repeat(64)], { STG_COS_APPID: "1250000000" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("缺少固定 COS 工具");
  });
  it("消费者工作流默认关、同run同源码、成功部署后串行上传；回滚与发布共锁", () => {
    const deploy = readFileSync(join(repoRoot, ".github/workflows/deploy-stg.yml"), "utf8"),
      rollback = readFileSync(join(repoRoot, ".github/workflows/rollback-stg.yml"), "utf8");
    expect(deploy).toContain("vars.STG_DEPLOY_ENABLED == 'true'");
    expect(deploy).toContain("run-id: ${{ github.event.workflow_run.id }}");
    expect(deploy.indexOf("node infra/deploy/orchestrate.mjs")).toBeLessThan(
      deploy.indexOf("node infra/deploy/upload-release.mjs"),
    );
    expect(deploy).toContain("--probe-config");
    expect(deploy).toContain("--probe-summary");
    expect(deploy).toContain("STG_WEAPP_UPLOAD_ENABLED: ${{ vars.STG_WEAPP_UPLOAD_ENABLED }}");
    expect(rollback).toContain(
      "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && vars.STG_DEPLOY_ENABLED == 'true' && inputs.execute == true",
    );
    expect(rollback).toContain("default: false");
    for (const text of [deploy, rollback]) {
      expect(text).toContain("group: deploy-stg");
      expect(text).toContain("cancel-in-progress: false");
      expect(text).toContain("if: always()");
    }
    expect(rollback).not.toMatch(/upload-release|migrate|seed|stage-assets/);
  });
});
