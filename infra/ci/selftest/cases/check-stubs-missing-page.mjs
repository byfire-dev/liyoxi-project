import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stubInputs } from "./check-stubs-missing-file.mjs";
import { ciCommand } from "./docs-check-wrong-permission.mjs";

export default {
  gate: "留桩清单的未来页面登记",
  mutation: "删除审批页面登记，不能用隐藏页面规范掩盖丢登记",
  reason: /未来页面登记缺失或回补说明不符：\/approvals/,
  run(ctx) {
    const [, script, ...args] = ciCommand(ctx, "node infra/ci/check-stubs.mjs");
    const input = stubInputs(ctx);
    const before = ctx.node(script, [...args, ...input.args]);
    if (before.status !== 0) throw new Error(`删除前没通过：${before.output.trim()}`);
    const page = join(input.dir, "pages.md");
    writeFileSync(
      page,
      readFileSync(page, "utf8")
        .split("\n")
        .filter((line) => !line.includes("`/approvals`"))
        .join("\n"),
    );
    return ctx.node(script, [...args, ...input.args]);
  },
};
