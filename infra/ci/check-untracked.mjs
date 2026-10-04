#!/usr/bin/env node
// 生成物入库检查：给定目录下有 git 没跟踪的文件即失败（开发计划 第 5.7 节“生成物”行）。
//
// 用法：node infra/ci/check-untracked.mjs <目录> [<目录> …]      在仓库根目录跑
// 它是 pnpm design:check 的第三步：重新生成 → git diff --exit-code → 本脚本。
// 为什么要有：git diff 看不到没跟踪的文件。生成脚本新出了一个文件、忘了 git add，前两步照样通过，
// 入库的就少一个生成物。
// 口径：目录下 git 没跟踪的文件一个都不许有，被 .gitignore 忽略的也算（生成物目录只由脚本写）。
// 退出码：0 通过；1 有没跟踪的文件；2 用法或环境错误。
// 本脚本不引依赖。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

function fail(message) {
  console.error(`生成物入库检查：${message}`);
  process.exit(2);
}

const dirs = process.argv.slice(2);
if (dirs.length === 0 || dirs.some((dir) => dir.startsWith("-"))) {
  fail("用法 node infra/ci/check-untracked.mjs <目录> [<目录> …]");
}
for (const dir of dirs) if (!existsSync(dir)) fail(`找不到目录 ${dir}`);

let untracked = [];
try {
  const out = execFileSync("git", ["ls-files", "-z", "--others", "--", ...dirs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  untracked = out.split("\0").filter(Boolean).sort();
} catch (error) {
  fail(`列不出文件，当前目录须在 git 仓库里。${error.message}`);
}

if (untracked.length > 0) {
  console.error(
    `生成物入库检查未通过：下面 ${untracked.length} 个文件 git 没有跟踪。是生成物就 git add 后一起提交，不是就挪走：`,
  );
  for (const file of untracked) console.error(`  ${file}`);
  process.exit(1);
}

console.log(`生成物入库检查通过：${dirs.join("、")} 下没有未跟踪的文件。`);
