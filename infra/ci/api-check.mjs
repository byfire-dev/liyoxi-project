#!/usr/bin/env node
// api-check 进 CI（W0-10；计划 第 4.2 节 Q3：tools/api-check 保留并改造）。
// 跑 python3 tools/api-check/check.py：路线图、各文档的结构化清单、分组文档三方自洽（契约与路线图一致由
// pnpm contract:docs-check 保证，两步合起来就是“代码、底稿、文档”三方对账）。
// check.py 的“表.列”一项连不上库时只写“未核对”、照样以 0 退出；CI 里这一项必须真的核对过，
// 所以这里把输出里出现“未核对”也按失败算。check.py 本身不改。
// 通过之后再跑两个生成脚本（gen_registries.py、gen_permissions.py），重新生成三份登记文档后 git diff --exit-code：
// 改了路线图、结构化清单或生成脚本里手写的默认值却没有重新生成登记文档的，在这里失败（W0-09b 留下的一处：
// 契约与登记文档对账，登记文档由这两个脚本生成，中间这一环此前没有检查）。要在 git 检出里跑。
//
// 用法（在仓库根目录）：
//   node infra/ci/api-check.mjs [--database <库名>]
//   --database  “表.列”连哪个库，缺省 lyx_migrate_check（空库跑完全部迁移的那个库）；只读。
//               环境里已经给了 API_CHECK_DB 时以它为准
// 连库：DATABASE_URL 或 PG* 环境变量（取主机、端口、账号）。不打印连接串。报告在 tools/api-check/out/（不入库）。
// 退出码：0 通过；1 check.py 有不通过的项、“表.列”未核对，或登记文档重新生成后有差异；2 用法或环境错误。
// 本脚本不引依赖。

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { pgEnv } from "./db-lib.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

function fail(message) {
  console.error(`api-check：没跑成。${message}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
let database = "lyx_migrate_check";
if (argv.length > 0) {
  if (argv[0] !== "--database" || argv[1] === undefined || argv.length > 2) {
    fail("用法：node infra/ci/api-check.mjs [--database <库名>]");
  }
  database = argv[1];
}
let env;
try {
  env = pgEnv();
} catch (error) {
  fail(error.message);
}
const result = spawnSync("python3", ["tools/api-check/check.py"], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { API_CHECK_DB: database, ...process.env, ...env },
  maxBuffer: 64 * 1024 * 1024,
});
if (result.error) fail(`python3 没跑起来：${result.error.message}`);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
// 报告很长，只留各节标题下的结论行；全文在 tools/api-check/out/api-check.md
const tail = output.slice(output.indexOf("## 2."));
process.stdout.write(tail.length > 0 ? tail : output);
if (result.status !== 0) {
  console.error(
    `api-check 未通过：check.py 以 ${result.status} 退出（全文见 tools/api-check/out/api-check.md）`,
  );
  process.exit(1);
}
if (output.includes("未核对")) {
  console.error(
    `api-check 未通过：“文档引用的表.列”一项未核对（连不上库 ${process.env.API_CHECK_DB ?? database}，或库里的表不全）。CI 里这一项必须核对`,
  );
  process.exit(1);
}

/** 由两个生成脚本写的登记文档：重新生成后应与入库的逐字节相同 */
const REGISTRY_DOCS = [
  "docs/api/registry-routes.md",
  "docs/api/registry-errors.md",
  "docs/api/registry-permissions.md",
];
for (const generator of ["gen_registries.py", "gen_permissions.py"]) {
  const generated = spawnSync("python3", [`tools/api-check/${generator}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (generated.error) fail(`python3 没跑起来：${generated.error.message}`);
  if (generated.status !== 0) {
    console.error(
      `api-check 未通过：${generator} 以 ${generated.status} 退出\n${generated.stdout}${generated.stderr}`,
    );
    process.exit(1);
  }
}
const diff = spawnSync("git", ["diff", "--exit-code", "--stat", "--", ...REGISTRY_DOCS], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (diff.error) fail(`git 没跑起来：${diff.error.message}`);
if (diff.status !== 0) {
  console.error(
    `api-check 未通过：登记文档重新生成后与入库的不一致（改了路线图、结构化清单或生成脚本，没有重新生成并提交）：\n${diff.stdout}${diff.stderr}`,
  );
  process.exit(1);
}
console.log(`登记文档（${REGISTRY_DOCS.length} 份）重新生成后无差异。`);
