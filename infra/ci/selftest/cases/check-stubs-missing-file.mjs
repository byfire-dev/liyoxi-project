// 新门禁必须拒绝计划中已回补文件的丢失；所有变异只在仓库外。
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ciCommand } from "./docs-check-wrong-permission.mjs";

export function stubInputs(ctx) {
  const dir = ctx.tempDir();
  cpSync(join(ctx.repoRoot, "docs/plan/stubs"), join(dir, "stubs"), { recursive: true });
  cpSync(join(ctx.repoRoot, "docs/plan/pages.md"), join(dir, "pages.md"));
  return { dir, args: ["--stubs", join(dir, "stubs"), "--pages", join(dir, "pages.md")] };
}
export default {
  gate: "留桩清单（check-stubs.mjs）",
  mutation: "删除计划映射中的一份已回补文件",
  reason: /缺少登记文件：m1-content-order-counts\.md/,
  run(ctx) {
    const [, script, ...args] = ciCommand(ctx, "node infra/ci/check-stubs.mjs");
    const input = stubInputs(ctx);
    const before = ctx.node(script, [...args, ...input.args]);
    if (before.status !== 0) throw new Error(`删除前没通过：${before.output.trim()}`);
    rmSync(join(input.dir, "stubs/m1-content-order-counts.md"));
    return ctx.node(script, [...args, ...input.args]);
  },
};
