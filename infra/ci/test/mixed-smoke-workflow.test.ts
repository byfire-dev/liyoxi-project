import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

it("只对本次选择文件在 PR 预检和 main push 重跑在役基线，保留手动十分钟验证", () => {
  const mixed = readFileSync(join(repoRoot, ".github/workflows/mixed-smoke.yml"), "utf8");
  const deploy = readFileSync(join(repoRoot, ".github/workflows/deploy-stg.yml"), "utf8");
  expect(mixed).toContain("on:\n  workflow_dispatch:");
  for (const event of ["push", "pull_request"])
    expect(mixed).toContain(
      `  ${event}:\n    branches: [main]\n    paths: [infra/ci/releases/pr288-staging.sh]`,
    );
  expect(mixed).toContain("if: github.event_name != 'workflow_dispatch'");
  expect(mixed).toContain("github.event.pull_request.base.sha || github.event.before");
  expect(mixed).toContain('previous=$(bash infra/ci/releases/pr288-staging.sh "$BASE_SHA")');
  expect(mixed).toContain('args=(--prev "$MIXED_PREVIOUS")');
  expect(mixed).toContain("jobs:\n  mixed-smoke:\n    name: mixed-smoke");
  expect(mixed).toContain("timeout-minutes: 10");
  expect(mixed).toContain("fetch-depth: 0");
  expect(mixed).toContain("persist-credentials: false");
  expect(mixed).toContain("--signal=TERM --kill-after=30s 8m");
  expect(mixed).toContain(
    'node infra/ci/mixed-version-smoke.mjs --report "$RUNNER_TEMP/mixed-smoke.json" "${args[@]}"',
  );
  expect(mixed).toContain(
    '.status == "passed" and .head == $head and .previous == $previous and .baseline == "explicit" and .cleanup.ok == true',
  );
  expect(mixed).not.toMatch(/pull_request_target:|schedule:|secrets\.|continue-on-error/);
  expect(deploy).toContain("workflows: [images, mixed-smoke]");
  expect(deploy).toContain("run-id: ${{ steps.release.outputs.images-run-id }}");
  expect(deploy).not.toContain("run-id: ${{ github.event.workflow_run.id }}");
  const gate = deploy.indexOf("run: node infra/ci/release-check-fetch.mjs");
  expect(gate).toBeGreaterThan(0);
  for (const action of [
    "uses: actions/download-artifact@",
    "SSH_PRIVATE_KEY:",
    'channel("pull"',
    "node infra/deploy/workflow-prepare.mjs",
  ])
    expect(gate).toBeLessThan(deploy.indexOf(action));
  expect(deploy).toContain("--compat-result passed --summary");
  expect(deploy).not.toMatch(/continue-on-error|--paginate|gh run watch/);
});
