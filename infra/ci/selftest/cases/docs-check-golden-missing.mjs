// W0-10 的门禁：公开、可选、验签路由的黄金文件（pnpm contract:docs-check；约定 C2）。黄金文件里少一条公开路由
//（等于契约里新出现了一条没评审过的公开路由），对账必须失败，并指出是哪一条。
// 做法同 docs-check-wrong-permission：在仓库外的副本里改，照 CI 里那一步实际的命令跑。
// 删哪一条不写死：取 public 那一组的第一条。
// CI 的 verify 里没有了 contract:docs-check 那一步、或对账不再比黄金文件时，这一例会红。
// 要 pnpm 在 PATH 上、本仓库的依赖已安装。不连库。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ciCommand, docsCheckCopy } from "./docs-check-wrong-permission.mjs";

const GOLDEN = "packages/contract/golden/open-routes.json";

export default {
  gate: "公开、可选、验签路由的黄金文件（contract:docs-check）",
  mutation: "黄金文件的 public 一组里删掉第一条",
  reason:
    /路由元数据对账未通过[\s\S]*黄金文件：public 路由不在黄金文件里：[A-Z]+ \/\S+ \S+（新增公开、可选、验签路由须评审）/,
  run(ctx) {
    const [tool, ...args] = ciCommand(ctx, "pnpm contract:docs-check");
    const dir = docsCheckCopy(ctx);
    const golden = JSON.parse(readFileSync(join(dir, GOLDEN), "utf8"));
    if (!Array.isArray(golden.public) || golden.public.length === 0)
      throw new Error(`${GOLDEN} 的 public 一组是空的`);
    golden.public = golden.public.slice(1);
    writeFileSync(join(dir, GOLDEN), `${JSON.stringify(golden, null, 2)}\n`);
    return ctx.run(tool, args, { cwd: dir });
  },
};
