import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { uploadReviewArtifacts } from "../../deploy/review-artifact.mjs";
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
  const tmp = makeTempDir("lyx-review-consumer-");
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

const review = (f: ReturnType<typeof fixture>) => ({
  ...f.options,
  tag: "weapp-v0.1.0",
  enabled: "true",
  freeze: "true",
});
it("机器人2同源提审保留原制品sha版本，并绑定发布标签与SDK版本", async () => {
  const f = fixture(),
    sdk = vi.fn(async (_options: { version: string }) => {});
  expect(await uploadReviewArtifacts(review(f), sdk)).toEqual({
    status: "uploaded",
    source,
    tag: "weapp-v0.1.0",
    version: "0.1.0",
    clientVersion: tag,
    robot: 2,
  });
  expect(sdk).toHaveBeenCalledOnce();
  expect(sdk.mock.calls[0]?.[0]).toEqual({
    project: join(f.dir, "project"),
    appid: f.manifest.appid,
    key: f.options.key,
    version: "0.1.0",
  });
});
it("未启用/未冻结/非法标签与原同源校验失败均零SDK调用", async () => {
  for (const change of [
    { enabled: "false" },
    { freeze: "false" },
    { tag: "0.1.0" },
    { tag: "weapp-v01.1.0" },
    { tag: "weapp-v1.0.0-beta" },
    { tag: "weapp-v1.0.0;id" },
    { tag: "weapp-v1000000.0.0" },
    { source: "b".repeat(40) },
    { manifestSha256: "0".repeat(64) },
    { appid: "wx1111111111111111" },
    { imageId: digest("9") },
  ]) {
    const f = fixture(),
      sdk = vi.fn(async () => {});
    await expect(uploadReviewArtifacts({ ...review(f), ...change }, sdk)).rejects.toThrow();
    expect(sdk).not.toHaveBeenCalled();
  }
  for (const kind of ["archive", "current", "deployment", "project"]) {
    const f = fixture(),
      sdk = vi.fn(async () => {});
    if (kind === "archive") writeFileSync(join(f.dir, "weapp.tar.gz"), "tampered");
    if (kind === "current") writeFileSync(f.options.releaseEnv, "LYX_TAG=sha-bbbbbbbbbbbb\n");
    if (kind === "deployment") {
      f.record.imageDigests.server = digest("9");
      writeFileSync(f.options.releaseLog, JSON.stringify(f.record) + "\n");
    }
    if (kind === "project") writeFileSync(join(f.dir, "project/project.config.json"), "{}");
    await expect(uploadReviewArtifacts(review(f), sdk)).rejects.toThrow();
    expect(sdk).not.toHaveBeenCalled();
  }
});
it("真实bash仅接收三固定参数，提审冻结与开发未冻结规则保持相反且独立", () => {
  const tmp = makeTempDir("lyx-review-bash-");
  cleanups.push(tmp.cleanup);
  const env = {
    ...process.env,
    LYX_SRC: repoRoot,
    LYX_NODE_HOME: tmp.dir,
    LYX_NODE_SUPERVISOR: "compose",
    LYX_NODE_PROVIDERS: "",
    LYX_WEAPP_UPLOAD_ENABLED: "true",
    STG_FREEZE: "true",
    STG_COS_APPID: "1250000000",
    WEAPP_APPID: "wx0123456789abcdef",
    WEAPP_API_BASE_URL: "https://api.stg.invalid",
  };
  const run = (args: string[], extra = {}) =>
    spawnSync("bash", [join(repoRoot, "infra/deploy/node-step.sh"), ...args], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  for (const bad of [
    "weapp-v01.2.3",
    "sha-aaaaaaaaaaaa",
    "weapp-v1.2.3;id",
    "../escape",
    "weapp-v1.2.3-alpha",
  ])
    expect(run(["weapp-review-upload", source, "0".repeat(64), bad]).status).toBe(2);
  expect(run(["weapp-review-upload", source, "0".repeat(64), "weapp-v1.2.3", "extra"]).status).toBe(
    2,
  );
  const args = ["weapp-review-upload", source, "0".repeat(64), "weapp-v1.2.3"];
  expect(run(args, { STG_FREEZE: "false" }).stderr).toContain("not_frozen");
  expect(run(args, { LYX_WEAPP_UPLOAD_ENABLED: "false" }).stderr).toContain(
    "disabled_or_bucket_unconfigured",
  );
  expect(run(["weapp-upload", source, "0".repeat(64)]).stderr).toContain('"reason":"frozen"');
  writeFileSync(join(tmp.dir, "release.env"), `LYX_TAG=${tag}\n`);
  const ready = run(args);
  expect(ready.status).toBe(1);
  expect(ready.stderr).toContain("缺少固定 COS 工具");
});
it("网关只接受受限诊断版本，不将任意版本头输出到访问日志", () => {
  const conf = readFileSync(join(repoRoot, "infra/docker/nginx/nginx.conf"), "utf8");
  expect(conf).toContain('"client_version":"$lyx_client_version","env_version":"$lyx_env_version"');
  expect(conf).toMatch(
    /map \$http_x_env_version \$lyx_env_version \{\s*default unknown;\s*develop develop;\s*trial trial;\s*release release;\s*\}/,
  );
  const log = conf.split("log_format lyx_json escape=json")[1]!.split("access_log")[0]!;
  expect(log).not.toContain("$http_x_client_version");
  expect(log).not.toContain("$http_x_env_version");
  expect(log).not.toContain("$request_uri");
});
