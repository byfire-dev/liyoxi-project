import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { releaseCheckRequests, selectReleaseChecks } from "../release-checks.mjs";
import { makeTempDir, repoRoot } from "./helpers.js";

const repository = "fixture/project",
  source = "a".repeat(40);
const run = (name: "images" | "mixed-smoke", id: number, number = 1) => ({
  id,
  name,
  run_number: number,
  run_attempt: 1,
  workflow_id: name === "images" ? 10 : 20,
  path: `.github/workflows/${name}.yml`,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  head_sha: source,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
});
const list = (...rows: ReturnType<typeof run>[]) => ({
  total_count: rows.length,
  workflow_runs: rows,
});
const input = () => ({
  repository,
  source,
  images: list(run("images", 101)),
  mixed: list(run("mixed-smoke", 201)),
});

it("只选同仓main push同完整SHA两工作流的最新成功，不回退到旧绿或不完整页", () => {
  const value = input();
  value.images = list(run("images", 103, 3), run("images", 101, 1), run("images", 102, 2));
  value.images.workflow_runs[0]!.run_attempt = 2;
  value.images.workflow_runs[0]!.path += "@main";
  expect(selectReleaseChecks(value)).toEqual({
    repository,
    source,
    compatibility: "passed",
    imagesRunId: 103,
    imagesAttempt: 2,
    mixedRunId: 201,
    mixedAttempt: 1,
  });
  for (const key of ["images", "mixed"] as const) {
    for (const override of [
      { status: "queued", conclusion: "success" },
      { conclusion: "failure" },
      { conclusion: "cancelled" },
      { head_sha: "b".repeat(40) },
      { head_sha: source.slice(0, 12) },
      { head_branch: "feature" },
      { event: "workflow_dispatch" },
      { repository: { full_name: "fork/project" } },
      { head_repository: { full_name: "fork/project" } },
      { path: ".github/workflows/other.yml" },
      { name: "other" },
      { run_attempt: 0 },
    ]) {
      const bad = input();
      const original = bad[key].workflow_runs[0]!;
      bad[key] = list(original, { ...original, id: original.id + 1, run_number: 2, ...override });
      expect(() => selectReleaseChecks(bad)).toThrow();
    }
    const incomplete = input();
    incomplete[key].total_count = 2;
    expect(() => selectReleaseChecks(incomplete)).toThrow();
    const missing = input();
    missing[key] = list();
    expect(() => selectReleaseChecks(missing)).toThrow();
    const duplicate = input();
    duplicate[key].workflow_runs.push(duplicate[key].workflow_runs[0]!);
    duplicate[key].total_count++;
    expect(() => selectReleaseChecks(duplicate)).toThrow();
  }
  const endpoints = releaseCheckRequests(repository, source);
  expect(Object.keys(endpoints)).toEqual(["images", "mixed-smoke"]);
  for (const path of Object.values(endpoints)) {
    expect(path).toContain(`branch=main&event=push&head_sha=${source}&per_page=100`);
    expect(path).not.toContain("status=");
  }
  expect(() => releaseCheckRequests("../outside", source)).toThrow();
});

it("真实CLI只读两个有界JSON，成功只输出安全结论；缺失/错误输入非零且不泄露正文", () => {
  const dir = makeTempDir("lyx-release-checks-");
  try {
    const images = join(dir.dir, "images.json"),
      mixed = join(dir.dir, "mixed.json");
    const data = input();
    writeFileSync(images, JSON.stringify(data.images));
    writeFileSync(mixed, JSON.stringify(data.mixed));
    const execute = () =>
      spawnSync(process.execPath, [join(repoRoot, "infra/ci/release-checks.mjs"), images, mixed], {
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: process.env.PATH, GITHUB_REPOSITORY: repository, EXPECTED_SHA: source },
      });
    const good = execute();
    expect(good.status).toBe(0);
    expect(good.stderr).toBe("");
    expect(JSON.parse(good.stdout)).toEqual(selectReleaseChecks(data));
    writeFileSync(mixed, "fictional-private-marker");
    const bad = execute();
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toBe("发布检查缺失、不完整或未成功，拒绝部署\n");
  } finally {
    dir.cleanup();
  }
});
