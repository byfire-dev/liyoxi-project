import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { repoRoot } from "./helpers.js";
interface Workflow {
  reviewIdentity(source: string, version: string, repository: string): string;
  reviewCiPassed(body: unknown, source: string, repository: string): boolean;
  reviewGitHubApi(
    run: (
      method: string,
      path: string,
      body?: unknown,
    ) => { status: number; stdout: string; stderr: string },
    now: () => number,
    wait: (ms: number) => Promise<void>,
  ): (method: string, path: string, body?: unknown) => Promise<unknown>;
  reviewWorkflow(
    options: Record<string, unknown>,
    deps: {
      readiness(): Promise<{ ok: boolean }[]>;
      api(method: string, path: string, body?: unknown): Promise<unknown>;
      channel(step: string, args: string[]): { status: number; stdout: string };
    },
  ): Promise<unknown>;
}
const helper = (await import(
  pathToFileURL(join(repoRoot, "infra/deploy/review-workflow.mjs")).href
)) as Workflow;
const source = "a".repeat(40),
  repository = "owner/repo",
  tag = "weapp-v0.1.0";
const ref = { ref: `refs/tags/${tag}`, object: { sha: source, type: "commit" } };
const run = {
  id: 101,
  run_number: 1,
  run_attempt: 1,
  workflow_id: 10,
  name: "ci",
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "main",
  head_sha: source,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
};
function fixture() {
  const events: string[] = [];
  const rawManifest = JSON.stringify({
    source,
    tag: `sha-${source.slice(0, 12)}`,
    appid: "wx0123456789abcdef",
    apiBaseUrl: "https://review.fixture.net",
    weappSha256: "a".repeat(64),
    images: Object.fromEntries(
      ["server", "gateway", "mediatool", "weapp-uploader"].map((name) => [
        name,
        {
          registryDigest: `sha256:${"1".repeat(64)}`,
          amd64ManifestDigest: `sha256:${"2".repeat(64)}`,
          amd64ConfigDigest: `sha256:${"3".repeat(64)}`,
        },
      ]),
    ),
  });
  const receipt = {
    status: "uploaded",
    source,
    tag,
    version: "0.1.0",
    clientVersion: `sha-${source.slice(0, 12)}`,
    robot: 2,
  };
  const api = vi.fn(async (method: string, path: string, _body?: unknown): Promise<unknown> => {
    events.push(`${method} ${path}`);
    if (path.includes("/actions/")) return { total_count: 1, workflow_runs: [run] };
    if (path.includes("matching-refs")) return [];
    return ref;
  });
  const channel = vi.fn((step: string, _args: string[]) => {
    events.push(step);
    return { status: 0, stdout: `LYX_WEAPP_REVIEW_UPLOAD=${JSON.stringify(receipt)}\n` };
  });
  const deps = {
    api,
    channel,
    readiness: vi.fn(async () => {
      events.push("readiness");
      return [{ ok: true }];
    }),
  };
  const options = {
    source,
    version: "0.1.0",
    repository,
    rawManifest,
    freeze: "true",
    enabled: "true",
    execute: "true",
  };
  return { events, options, deps, receipt };
}
it("readiness与同源main CI在创建标签前，机器人2严格3参，版本取标签且核完整回执", async () => {
  const f = fixture();
  expect(await helper.reviewWorkflow(f.options, f.deps)).toEqual(f.receipt);
  expect(f.events[0]).toBe("readiness");
  expect(f.events[1]).toContain("/ci.yml/runs?");
  expect(f.events.at(-2)).toBe(`POST repos/${repository}/git/refs`);
  expect(f.events.at(-1)).toBe("weapp-review-upload");
  expect(f.deps.channel).toHaveBeenCalledWith("weapp-review-upload", [
    source,
    createHash("sha256").update(f.options.rawManifest).digest("hex"),
    tag,
  ]);
  expect(f.deps.api.mock.calls.some((v) => v[0] === "DELETE")).toBe(false);
});
it("非法输入、缺冻结/启用/确认及readiness失败都零标签创建和节点调用", async () => {
  const f = fixture();
  for (const version of ["01.2.3", "weapp-v1.2.3", "1.2.3;id", "1.2.3-beta", "1000000.0.0"])
    expect(() => helper.reviewIdentity(source, version, repository)).toThrow();
  for (const change of [{ freeze: "false" }, { enabled: "false" }, { execute: "false" }])
    await expect(helper.reviewWorkflow({ ...f.options, ...change }, f.deps)).rejects.toThrow();
  f.deps.readiness.mockResolvedValue([{ ok: false }]);
  await expect(helper.reviewWorkflow(f.options, f.deps)).rejects.toThrow("出包条件");
  expect(f.deps.api).not.toHaveBeenCalled();
  expect(f.deps.channel).not.toHaveBeenCalled();
});
it("不隐去较新RED、运行中或跨仓/错sha的CI；结果不完整也拒绝", () => {
  for (const change of [
    { conclusion: "failure" },
    { status: "in_progress" },
    { head_sha: "b".repeat(40) },
    { event: "pull_request" },
    { head_repository: { full_name: "other/repo" } },
  ])
    expect(
      helper.reviewCiPassed(
        { total_count: 1, workflow_runs: [{ ...run, ...change }] },
        source,
        repository,
      ),
    ).toBe(false);
  expect(
    helper.reviewCiPassed(
      {
        total_count: 2,
        workflow_runs: [run, { ...run, id: 102, run_number: 2, conclusion: "failure" }],
      },
      source,
      repository,
    ),
  ).toBe(false);
  expect(helper.reviewCiPassed({ total_count: 2, workflow_runs: [run] }, source, repository)).toBe(
    false,
  );
});
it("既有标签直接拒绝；SSH失败或丢回执即使tag同sha也保留契约保护", async () => {
  const f = fixture();
  const base = f.deps.api.getMockImplementation()!;
  f.deps.api.mockImplementation(async (method, path, body) =>
    path.includes("matching-refs") ? [ref] : base(method, path, body),
  );
  await expect(helper.reviewWorkflow(f.options, f.deps)).rejects.toThrow("标签已存在");
  expect(f.deps.channel).not.toHaveBeenCalled();
  expect(f.deps.api.mock.calls.some((v) => ["POST", "DELETE"].includes(v[0]))).toBe(false);
  f.deps.api.mockImplementation(base);
  f.deps.channel.mockReturnValue({ status: 1, stdout: "" });
  await expect(helper.reviewWorkflow(f.options, f.deps)).rejects.toThrow("本轮标签保留");
  expect(f.deps.api.mock.calls.at(-1)?.[0]).toBe("GET");
  expect(f.deps.api.mock.calls.some((v) => v[0] === "DELETE")).toBe(false);
  expect(f.deps.channel).toHaveBeenCalledTimes(1);
});
it("标签被移动/创建回执未知不删除、不重试上传；只尝试读核", async () => {
  const f = fixture();
  const base = f.deps.api.getMockImplementation()!;
  f.deps.channel.mockReturnValue({ status: 1, stdout: "" });
  f.deps.api.mockImplementation(async (method, path, body) =>
    path.includes("/git/ref/tags/")
      ? { ...ref, object: { sha: "b".repeat(40), type: "commit" } }
      : base(method, path, body),
  );
  await expect(helper.reviewWorkflow(f.options, f.deps)).rejects.toThrow("本轮标签保留");
  expect(f.deps.api.mock.calls.some((v) => v[0] === "DELETE")).toBe(false);
  const unknown = fixture();
  const original = unknown.deps.api.getMockImplementation()!;
  unknown.deps.api.mockImplementation(async (method, path, body) => {
    if (method === "POST") throw Error("响应丢失");
    return original(method, path, body);
  });
  await expect(helper.reviewWorkflow(unknown.options, unknown.deps)).rejects.toThrow(
    "已尝试只读核对",
  );
  expect(unknown.deps.api.mock.calls.filter((v) => v[0] === "POST")).toHaveLength(1);
  expect(unknown.deps.api.mock.calls.at(-1)?.[1]).toContain("/git/ref/tags/");
  expect(unknown.deps.api.mock.calls.some((v) => v[0] === "DELETE")).toBe(false);
  expect(unknown.deps.channel).not.toHaveBeenCalled();
});
it("错机器人/版本回执拒绝，不把节点exit0当成功", async () => {
  const f = fixture();
  f.deps.channel.mockReturnValue({
    status: 0,
    stdout: `LYX_WEAPP_REVIEW_UPLOAD=${JSON.stringify({ ...f.receipt, robot: 1 })}\n`,
  });
  await expect(helper.reviewWorkflow(f.options, f.deps)).rejects.toThrow("本轮标签保留");
  expect(f.deps.api.mock.calls.some((v) => v[0] === "DELETE")).toBe(false);
});
it("GitHub写间隔至少60秒，403/429后停止全部读写且不重试", async () => {
  let now = 0;
  const execute = vi.fn(() => ({ status: 0, stdout: "{}", stderr: "" }));
  const wait = vi.fn(async (ms: number) => {
    now += ms;
  });
  const api = helper.reviewGitHubApi(execute, () => now, wait);
  await api("POST", "tag");
  now += 1000;
  await api("DELETE", "tag");
  expect(wait).toHaveBeenCalledWith(59000);
  expect(now).toBe(60000);
  for (const status of [403, 429]) {
    const rejected = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: `gh: rejected (HTTP ${status})`,
    }));
    const blocked = helper.reviewGitHubApi(
      rejected,
      () => 0,
      async () => {},
    );
    await expect(blocked("POST", "tag")).rejects.toThrow();
    await expect(blocked("GET", "tag")).rejects.toThrow("GitHub已停止");
    await expect(blocked("DELETE", "tag")).rejects.toThrow("GitHub已停止");
    expect(rejected).toHaveBeenCalledTimes(1);
  }
});
it("实际workflow输入命令接受普通版本，拒绝斜杠/反斜杠/前导零，零外呼", () => {
  const line = readFileSync(join(repoRoot, ".github/workflows/weapp-review-upload.yml"), "utf8")
    .split("\n")
    .find((v) => v.trim().startsWith("node --input-type=module -e"));
  expect(line).toBeDefined();
  for (const version of ["0.1.0", "123456.0.999999", "01.2.3", "0/1/0", "0\\11\\20", "1.2.3;id"]) {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", line!.trim()], {
      env: { ...process.env, EXPECTED_SHA: source, REVIEW_VERSION: version },
      encoding: "utf8",
    });
    expect(result.status).toBe(["0.1.0", "123456.0.999999"].includes(version) ? 0 : 1);
  }
});
it("手动工作流默认关闭，main归属核对早于执行候选源码，原同提交事实检查在上传前", () => {
  const source = readFileSync(join(repoRoot, ".github/workflows/weapp-review-upload.yml"), "utf8");
  expect(source).toContain("group: deploy-stg");
  expect(source).toContain("cancel-in-progress: false");
  expect(source).toContain(
    "vars.STG_WEAPP_REVIEW_UPLOAD_ENABLED == 'true' && vars.STG_FREEZE == 'true' && inputs.execute == true",
  );
  expect(source.indexOf("git merge-base --is-ancestor")).toBeLessThan(
    source.indexOf("pnpm install"),
  );
  expect(source.indexOf("release-check-fetch.mjs")).toBeLessThan(
    source.indexOf("review-workflow.mjs"),
  );
  expect(source).toContain("persist-credentials: false");
  expect(source).not.toContain("miniprogram-ci");
});
