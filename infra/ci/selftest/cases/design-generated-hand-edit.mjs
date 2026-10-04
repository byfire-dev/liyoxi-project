// W0-26 的门禁：生成物无差异（pnpm design:check）。手改一行已入库的生成物：重新生成后必须有差异。
// 步骤见 ../lib/design-check.mjs：在临时仓库里照根脚本 design:check 走，不碰本仓库的工作区。
// design:check 去掉 git diff 那一步、生成脚本不再重写这个文件时，这一例会红。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { designCheck, GENERATED } from "../lib/design-check.mjs";

const VARIABLE = "$lyx-radius-card:";
const HAND_EDITED = `${VARIABLE} 999px;`;

export default {
  gate: "生成物无差异（design:check）",
  mutation: "手改一行已入库的生成物（merchant.scss 的卡片圆角）",
  reason:
    /diff --git a\/packages\/shared\/src\/design\/generated\/merchant\.scss[\s\S]*\n-\$lyx-radius-card: 999px;\n\+\$lyx-radius-card: \d+px;/,
  run(ctx) {
    return designCheck(ctx, {
      beforeAdd(dir) {
        const file = join(dir, GENERATED, "merchant.scss");
        const lines = readFileSync(file, "utf8").split("\n");
        const index = lines.findIndex((line) => line.startsWith(VARIABLE));
        if (index < 0) throw new Error(`merchant.scss 里找不到 ${VARIABLE}`);
        lines[index] = HAND_EDITED;
        writeFileSync(file, lines.join("\n"));
      },
    });
  },
};
