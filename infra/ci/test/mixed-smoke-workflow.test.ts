import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

it("混跑仅main/十分钟，发布在凭据与节点动作前汇合同SHA且取images的run", () => {
  const mixed = readFileSync(join(repoRoot, ".github/workflows/mixed-smoke.yml"), "utf8");
  const deploy = readFileSync(join(repoRoot, ".github/workflows/deploy-stg.yml"), "utf8");
  expect(mixed).toContain("on:\n  push:\n    branches: [main]");
  expect(mixed).toContain("jobs:\n  mixed-smoke:\n    name: mixed-smoke");
  expect(mixed).toContain("timeout-minutes: 10");
  expect(mixed).toContain("fetch-depth: 0");
  expect(mixed).toContain("persist-credentials: false");
  expect(mixed).toContain("--signal=TERM --kill-after=30s 8m");
  expect(mixed).toContain(
    'node infra/ci/mixed-version-smoke.mjs --report "$RUNNER_TEMP/mixed-smoke.json"',
  );
  expect(mixed).not.toMatch(/pull_request:|workflow_dispatch:|secrets\.|continue-on-error/);
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
