import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

const images = readFileSync(join(repoRoot, ".github/workflows/images.yml"), "utf8");
const deploy = readFileSync(join(repoRoot, ".github/workflows/deploy-stg.yml"), "utf8");
const job = (text: string, id: string) =>
  text.split(`  ${id}:\n`)[1]?.split(/^ {2}[\w-]+:\n/m)[0] ?? "";

describe("W2-25b 构建与外部写边界", () => {
  it("PR 构建 job 运行四镜像/SDK/原体积门禁，没有凭据或云写", () => {
    const body = job(images, "build-images");
    expect(body).toContain("server gateway");
    expect(body).toContain("mediatool weapp-uploader");
    expect(body).toContain("pnpm weapp:build");
    expect(body).toContain("pg_dump --version");
    expect(body).toContain("--check");
    expect(body).toContain("-m unittest -v test_adapter.py");
    expect(body).not.toMatch(/secrets\.|docker (push|login)|artifact\.put|orchestrate\.mjs/);
    expect(images).toContain("name: images-build-${{ github.sha }}");
  });

  it("发布只能在 main 的 push/manual 且明确启用，制品写另有配置；没有实际小程序上传", () => {
    const body = job(images, "publish-images");
    expect(body).toContain(
      "if: vars.STG_IMAGES_PUBLISH_ENABLED == 'true' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    );
    expect(body).toContain("--password-stdin");
    expect(body).toContain('test "$STG_ARTIFACT_UPLOAD_ENABLED" = true');
    expect(body).toContain("LYX_COS_ARTIFACT_UPLOAD_ENABLED=true");
    expect(body.indexOf("s.source!==process.env.GITHUB_SHA")).toBeLessThan(
      body.indexOf("docker push"),
    );
    expect(body).not.toMatch(/--upload\b|\bweapp-upload\b/);
    expect(body).toContain("if: always()");
  });

  it("PG/Redis 只手动且启用才转存多架构清单；不 pull/tag/push 单平台", () => {
    const body = job(images, "mirror-base");
    expect(body).toContain(
      "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && vars.STG_IMAGES_PUBLISH_ENABLED == 'true' && inputs.mirror_base == true",
    );
    expect(body.match(/docker buildx imagetools create/g)).toHaveLength(2);
    expect(body).toMatch(/postgres:17-trixie@sha256:[a-f0-9]{64}/);
    expect(body).toMatch(/redis:7\.4-alpine@sha256:[a-f0-9]{64}/);
    expect(body).not.toMatch(/docker (pull|tag|push) /);
  });

  it("部署整个 job 默认关闭，同源 main 成功 push/runID/HEAD 绑定，先核摘要再编排", () => {
    const body = job(deploy, "deploy-stg");
    expect(body).toContain(
      "if: vars.STG_DEPLOY_ENABLED == 'true' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(body).toContain("run-id: ${{ github.event.workflow_run.id }}");
    expect(body).toContain("repository: ${{ github.repository }}");
    expect(body).toContain("images-release-${{ github.event.workflow_run.head_sha }}");
    expect(body).toContain("v.source!==process.env.EXPECTED_SHA");
    expect(body.indexOf('channel("image-facts"')).toBeLessThan(
      body.indexOf("node infra/deploy/orchestrate.mjs"),
    );
    expect(body).toContain("mode:0o600");
    expect(body).toContain("if: always()");
    expect(deploy).toContain("cancel-in-progress: false");
    expect(body).not.toMatch(/\bweapp-upload\b/);
  });

  it.each(["--unknown", "--upload"])("真实 uploader 命令 %s 失败关闭且不回显账号输入", (arg) => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "infra/docker/weapp-uploader/upload.mjs"), arg],
      {
        env: { PATH: process.env.PATH },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).not.toMatch(/上传完成/);
    expect(result.stderr).toBe("小程序上传器：参数、SDK 或上传失败\n");
  });
});
