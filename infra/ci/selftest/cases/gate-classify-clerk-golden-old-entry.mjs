// 店员黄金按 operationId 只增；往已有路由数组加一个路径也必须被拦住。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATH = "apps/api/golden/clerk-visible-keys.snap";

export default {
  gate: "门禁改动分类（店员黄金旧条目）",
  mutation: "工作包 PR 改掉已有店员路由的字段路径数组，没有 gate-change 标签",
  reason: /clerk-visible-keys\.snap[\s\S]*改了店员黄金旧条目[\s\S]*没有 gate-change 标签/,
  run(ctx) {
    const base = readFileSync(join(ctx.repoRoot, PATH), "utf8");
    const changed = JSON.parse(base);
    const key = Object.keys(changed)[0];
    if (!key || !Array.isArray(changed[key])) throw new Error("店员黄金没有可修改的旧条目");
    changed[key].push("extra");
    const dir = ctx.gitRepo({ [PATH]: base });
    ctx.git(dir, "commit", "-q", "-m", "base");
    ctx.writeFiles(dir, { [PATH]: `${JSON.stringify(changed, null, 2)}\n` });
    ctx.git(dir, "add", "-A");
    ctx.git(dir, "commit", "-q", "-m", "head");
    return ctx.node("infra/ci/classify-gate-changes.mjs", ["--base", "HEAD~1"], { cwd: dir });
  },
};
