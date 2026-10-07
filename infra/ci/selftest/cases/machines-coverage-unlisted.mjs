// CI 实际严格契约模式下，副本中拿走引用制造的新未覆盖行不能自动写入存量。
import { cpSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ciCommand } from "./docs-check-wrong-permission.mjs";
import { contractCopy } from "./api-registries-check-wrong-error-code.mjs";

export function coverageInput(ctx) {
  const [tool, ...args] = ciCommand(ctx, "pnpm machines:coverage");
  const baseline = readFileSync(
    join(ctx.repoRoot, "infra/ci/machines-coverage-baseline.jsonl"),
    "utf8",
  );
  const dir = ctx.tempDir();
  return { tool, args, baseline, path: join(dir, "baseline.jsonl"), dir };
}
export default {
  gate: "契约状态机覆盖（--strict --contract）",
  mutation: "在仓库外副本拿走真实迁移引用，基线保持原样",
  reason: /未收录在基线的行：/,
  run(ctx) {
    const input = coverageInput(ctx);
    const dir = contractCopy(ctx);
    cpSync(join(ctx.repoRoot, "packages/shared"), join(dir, "packages/shared"), {
      recursive: true,
      filter: (path) => !path.endsWith("/node_modules") && !path.endsWith("/dist"),
    });
    symlinkSync(
      join(ctx.repoRoot, "packages/shared/node_modules"),
      join(dir, "packages/shared/node_modules"),
      "dir",
    );
    ctx.writeFiles(dir, { "infra/ci/machines-coverage-baseline.jsonl": input.baseline });
    const before = ctx.run(input.tool, input.args, { cwd: dir });
    if (before.status !== 0) throw new Error(`变异前没通过：${before.output.trim()}`);
    // 只删副本中的引用文字，不改真实迁移或根目录冻结文档。即使存量已清零，这也制造新未覆盖行。
    const fragDir = join(dir, "docs/api/working/frag");
    for (const file of readdirSync(fragDir).filter((name) => name.endsWith(".json"))) {
      const path = join(fragDir, file);
      const fragment = JSON.parse(readFileSync(path, "utf8"));
      if (file === "x01-events-jobs.json") fragment.attributions = [];
      else for (const endpoint of fragment.endpoints ?? []) endpoint.transitions = [];
      writeFileSync(path, `${JSON.stringify(fragment)}\n`);
    }
    return ctx.run(input.tool, input.args, { cwd: dir });
  },
};
