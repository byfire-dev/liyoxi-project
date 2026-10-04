// W0-26 的门禁：生成物无差异（pnpm design:check）。有一个生成物没入库：
// git diff 只比已跟踪的文件，看不出来，由第三步 infra/ci/check-untracked.mjs 拦。
// 步骤见 ../lib/design-check.mjs。design:check 去掉第三步时，这一例会红。
import { designCheck, GENERATED } from "../lib/design-check.mjs";

export default {
  gate: "生成物无差异（design:check）",
  mutation: "生成物 tokens.ts 没有入库（从暂存区拿掉）",
  reason:
    /生成物入库检查未通过：下面 1 个文件 git 没有跟踪[\s\S]*packages\/shared\/src\/design\/generated\/tokens\.ts/,
  run(ctx) {
    return designCheck(ctx, {
      afterAdd(dir) {
        ctx.git(dir, "rm", "-q", "--cached", `${GENERATED}/tokens.ts`);
      },
    });
  },
};
