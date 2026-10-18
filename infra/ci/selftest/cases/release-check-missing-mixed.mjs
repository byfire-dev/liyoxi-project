import { join } from "node:path";

export default {
  gate: "同提交混跑发布阻断",
  mutation: "images 已成功，同 SHA 的 mixed-smoke 尚无运行",
  reason: /发布检查缺失、不完整或未成功，拒绝部署/u,
  run(ctx) {
    const source = "a".repeat(40),
      repository = "fixture/project";
    const dir = ctx.tempDir();
    ctx.writeFiles(dir, {
      "images.json": JSON.stringify({
        total_count: 1,
        workflow_runs: [
          {
            id: 1,
            run_number: 1,
            run_attempt: 1,
            workflow_id: 1,
            name: "images",
            path: ".github/workflows/images.yml",
            event: "push",
            head_branch: "main",
            head_sha: source,
            repository: { full_name: repository },
            head_repository: { full_name: repository },
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
      "mixed.json": JSON.stringify({ total_count: 0, workflow_runs: [] }),
    });
    return ctx.node(
      "infra/ci/release-checks.mjs",
      [join(dir, "images.json"), join(dir, "mixed.json")],
      {
        env: { EXPECTED_SHA: source, GITHUB_REPOSITORY: repository },
      },
    );
  },
};
