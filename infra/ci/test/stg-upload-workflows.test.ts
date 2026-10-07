import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const deploy = read(".github/workflows/deploy-stg.yml");
const rollback = read(".github/workflows/rollback-stg.yml");
const step = (text: string, name: string) =>
  text.split(`      - name: ${name}\n`)[1]?.split("      - name:")[0] ?? "";

describe("W2-26同源工作流消费者", () => {
  it("消费者默认关、同run同源码、成功部署后串行上传；回滚与发布共锁", () => {
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

  it("新reader目标追加在固定SDK校验之后，原adapter整行和PR无凭据构建保持", () => {
    const images = read(".github/workflows/images.yml");
    const original =
      'cd infra/bootstrap/cos-adapter && "$RUNNER_TEMP/cos-tools/bin/python" -m unittest -v test_adapter.py';
    const reader = '"$RUNNER_TEMP/cos-tools/bin/python" -m unittest -v test_artifact_reader.py';
    expect(images).toContain(`${original}\n          ${reader}`);
    expect(images.indexOf("cos-adapter/adapter.py --check")).toBeLessThan(images.indexOf(reader));
    expect(images).toContain("--require-hashes --no-build-isolation");
  });

  it("发布与回滚均保留探测/失败摘要、always清理且冻结配置传入实际消费者", () => {
    const release = step(deploy, "部署并保存持续探测");
    expect(release).toContain("node infra/deploy/workflow-prepare.mjs");
    expect(release).toContain("STG_PROBE_CONFIG: ${{ vars.STG_PROBE_CONFIG }}");
    const rollbackRun = step(rollback, "校验并执行有探测的回滚");
    expect(rollbackRun).toContain("run: node infra/deploy/rollback-workflow.mjs");
    expect(rollbackRun).toContain("ROLLBACK_FORCE: ${{ inputs.force }}");
    expect(rollbackRun).toContain("ROLLBACK_REASON: ${{ inputs.reason }}");
    expect(rollback).toMatch(/execute:\n(?: {8}[^\n]*\n)* {8}default: false/);
    expect(rollback).toMatch(/force:\n(?: {8}[^\n]*\n)* {8}default: false/);
    for (const text of [release, rollbackRun])
      expect(text).toContain("STG_FREEZE: ${{ vars.STG_FREEZE }}");
    for (const text of [deploy, rollback]) {
      const cleanup = step(text, "清理 SSH 文件");
      expect(cleanup).toContain("if: always()");
      expect(cleanup).toContain('run: rm -f "$HOME/.ssh/id_ed25519" "$HOME/.ssh/known_hosts"');
      expect(text).toContain("${{ runner.temp }}/probe-summary.json");
      expect(text).not.toContain("continue-on-error");
    }
    expect(step(deploy, "保留部署、探测与上传摘要")).toContain("if: always()");
    expect(step(rollback, "保留回滚与探测摘要")).toContain("if: always()");
  });
});
