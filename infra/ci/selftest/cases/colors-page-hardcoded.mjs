// W0-26 的门禁：页面不写色值（pnpm lint:colors）。夹具是 infra/ci/fixtures/colors/bad：
// 三个前端的页面文件里写十六进制、rgb()、rgba()、hsl() 各一处，检查必须失败并逐个指出文件、行、列。
// 照根脚本 lint:colors 的原文跑，后面接 --root 指到夹具；白名单用仓库里真的那一份。
// 检查脚本被改成空转、少认一种写法，或白名单里放进 apps/ 这样的大口子时，这一例会红。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const at = (file, position, found) => `${file}:${position}: 写了色值 ${found}`;
const EXPECTED = [
  "页面色值检查未通过，共 4 处",
  at("apps/weapp/src/pages/mine/index.ts", "2:37", "hsl(…)"),
  at("apps/weapp/src/pages/order/index.scss", "6:12", "#a63f12"),
  at("apps/admin/src/pages/orders/index.tsx", "3:11", "rgb(…)"),
  at("apps/portal/src/styles/page.css", "7:15", "rgba(…)"),
];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default {
  gate: "页面不写色值（lint:colors）",
  mutation: "页面夹具里写十六进制色值、rgb()、rgba()、hsl() 各一处",
  reason: new RegExp(EXPECTED.map(escape).join("[\\s\\S]*")),
  run(ctx) {
    const manifest = JSON.parse(readFileSync(join(ctx.repoRoot, "package.json"), "utf8"));
    const script = manifest.scripts?.["lint:colors"];
    if (script !== "node infra/ci/check-colors.mjs") {
      throw new Error(`根脚本 lint:colors 不是 node infra/ci/check-colors.mjs，现在是：${script}`);
    }
    const [, file] = script.split(" ");
    return ctx.node(file, ["--root", join(ctx.repoRoot, "infra/ci/fixtures/colors/bad")]);
  },
};
