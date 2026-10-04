// 设计生成物的几个反例共用的步骤（W0-26）：在仓库外的临时 git 仓库里照根脚本 design:check 走一遍，
// 不碰本仓库的工作区。本文件不是反例（反例只收 cases/*.mjs）。
//
// 根脚本 design:check 是三步：重新生成 → git diff --exit-code → 生成物目录下没有未跟踪的文件。这里：
//   1. 把入库的生成物原样拷进临时仓库并加入暂存区（相当于“已提交的内容”），变异做在临时仓库里；
//   2. 第一步改用 generate.ts 的 --out，把重新生成的结果写进临时仓库（来源仍是本仓库的 tokens.json 与图标源）；
//   3. 后两步照根脚本的原文，在临时仓库里跑。
// 根脚本少了哪一步、换了写法，这里抛错，几个反例一起红（“反例没造出来”）。
// 返回第一个失败的那一步的 { status, output }；三步都过了，返回最后一步的（退出码 0，框架判“检查没有失败”）。

import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GENERATED = "packages/shared/src/design/generated";

const STEPS = [
  "pnpm design:generate",
  `git diff --exit-code -- ${GENERATED}`,
  `node infra/ci/check-untracked.mjs ${GENERATED}`,
];

/**
 * beforeAdd(dir)：加入暂存区之前的变异（手改、多放一个文件：都算“已提交”）。
 * afterAdd(dir)：加入暂存区之后的变异（把一个生成物从暂存区拿掉：它成了没入库的文件）。
 */
export function designCheck(ctx, { beforeAdd, afterAdd } = {}) {
  const manifest = JSON.parse(readFileSync(join(ctx.repoRoot, "package.json"), "utf8"));
  const script = manifest.scripts?.["design:check"];
  if (script !== STEPS.join(" && ")) {
    throw new Error(
      `根脚本 design:check 不是预期的三步（${STEPS.join(" && ")}），现在是：${script}`,
    );
  }

  const dir = ctx.gitRepo({ "README.md": "设计生成物反例的临时仓库\n" });
  cpSync(join(ctx.repoRoot, GENERATED), join(dir, GENERATED), { recursive: true });
  beforeAdd?.(dir);
  ctx.git(dir, "add", "-A");
  afterAdd?.(dir);

  const generate = ctx.run("pnpm", [
    "--filter",
    "@liyoxi/shared",
    "exec",
    "tsx",
    "scripts/generate.ts",
    "--no-preview",
    "--out",
    join(dir, GENERATED),
  ]);
  if (generate.status !== 0) return generate;
  for (const step of STEPS.slice(1)) {
    const [command, ...args] = step.split(" ");
    const result =
      command === "node"
        ? ctx.node(args[0], args.slice(1), { cwd: dir })
        : ctx.run(command, args, { cwd: dir });
    if (result.status !== 0) return result;
  }
  return { status: 0, output: "design:check 的三步都通过了" };
}
