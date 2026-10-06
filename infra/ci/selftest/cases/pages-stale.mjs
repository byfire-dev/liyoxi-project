// W0-28 的门禁：页面清单无差异（node infra/ci/pages/generate.mjs --check）。
// 手改生成物：把入库的 pages.md 里一页的“已实现”翻转，登记表没动，核对必须失败。
// 页面完成前后都能造出同一类反例；脚本的 --check 不再比对内容时这一例会红。
import { readFileSync } from "node:fs";
import { join } from "node:path";

export default {
  gate: "页面清单无差异（pages/generate.mjs --check）",
  mutation: "手改 docs/plan/pages.md：翻转“资质审核”一行的已实现值",
  reason:
    /pages\.md 与页面登记不一致[\s\S]*入库的：[^\n]*资质审核[^\n]*\| (是|否) \|\r?\n[\s\S]*应该是：[^\n]*资质审核[^\n]*\| (?!\1)(是|否) \|(?:\r?\n|$)/,
  run(ctx) {
    const lines = readFileSync(join(ctx.repoRoot, "docs/plan/pages.md"), "utf8").split("\n");
    const index = lines.findIndex(
      (line) => line.includes("| 资质审核 |") && /\| (是|否) \|$/.test(line),
    );
    if (index < 0) throw new Error("pages.md 里找不到“资质审核”那一行的已实现值");
    lines[index] = lines[index].replace(/\| (是|否) \|$/, (_, value) =>
      value === "是" ? "| 否 |" : "| 是 |",
    );
    const dir = ctx.tempDir();
    ctx.writeFiles(dir, { "pages.md": lines.join("\n") });
    return ctx.node("infra/ci/pages/generate.mjs", ["--check", "--out", join(dir, "pages.md")]);
  },
};
