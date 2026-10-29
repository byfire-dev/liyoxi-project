import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLAGS } from "../../../../packages/contract/src/config/flags.ts";
import { reviewReadiness } from "../../review-readiness.mjs";
import { privacyReport, reviewFlagErrors } from "../../../deploy/review-check.mjs";

export default {
  gate: "送审出包条件",
  mutation: "缺E5、打开默认关闭开关、增加未登记位置调用",
  reason: "已拒绝缺E5、错误默认开关与额外位置调用",
  async run(ctx) {
    const root = ctx.tempDir(),
      commit = "a".repeat(40);
    ctx.writeFiles(root, {
      "docs/plan/owner-checklist.md": "| E5 | 商户核对 | V2 | 未开始 | | |",
      "docs/plan/platform-config.md": readFileSync(
        join(ctx.repoRoot, "docs/plan/platform-config.md"),
        "utf8",
      ),
      "apps/weapp/src/pages.ts": "const pages = [];",
      "apps/weapp/src/app.config.ts": "export default defineAppConfig({});",
      "apps/weapp/src/page.ts": "import Taro from '@tarojs/taro'; Taro.chooseLocation({});",
    });
    const results = await reviewReadiness({
      root,
      commit,
      freeze: "true",
      run: (_command, args) => ({ status: 0, stdout: args[0] === "rev-parse" ? commit : "" }),
      fetcher: async () => {
        throw Error("反例不允许联网");
      },
    });
    const flags = Object.fromEntries(
      FLAGS.filter((v) => v.exposedTo === "client").map((v) => [v.key, v.defaultValue]),
    );
    Object.assign(flags, {
      "weapp.video.ad.enabled": false,
      "export.enabled": false,
      "weapp.trailer.autoplay": true,
    });
    const rejected =
      results.find((v) => v.name === "E5")?.ok === false &&
      reviewFlagErrors(flags).includes("weapp.trailer.autoplay：下发值与送审清单不同或缺失") &&
      privacyReport(root).errors.includes("隐私指引第8项与实际调用不一致");
    return {
      status: rejected ? 1 : 0,
      output: rejected ? "已拒绝缺E5、错误默认开关与额外位置调用" : "送审反例被放过",
    };
  },
};
