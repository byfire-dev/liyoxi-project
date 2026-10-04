// W0-26 的门禁：生成物无差异（pnpm design:check）。生成物目录里多出一个手写文件并已入库：
// git diff 看不出多出来的文件，由生成脚本拦（目录只由脚本写）。
// 色值检查放行生成物目录，手写文件混进去就绕过了“页面不写色值”，所以这一例要常驻。
// 步骤见 ../lib/design-check.mjs。生成脚本不再拒绝目录里多出来的文件时，这一例会红。
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { designCheck, GENERATED } from "../lib/design-check.mjs";

export default {
  gate: "生成物无差异（design:check）",
  mutation: "生成物目录里多出一个手写的 handwritten.scss，已入库",
  reason: /design:generate：.*里有不是脚本写的文件：handwritten\.scss/,
  run(ctx) {
    return designCheck(ctx, {
      beforeAdd(dir) {
        writeFileSync(join(dir, GENERATED, "handwritten.scss"), "$lyx-mine: 1px;\n");
      },
    });
  },
};
