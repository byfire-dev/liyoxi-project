// “类型解析不靠提升”的门禁（pnpm check:type-hoist；来历见 infra/ci/README.md 第 7 节）。
// 在仓库外摆一棵照 pnpm 装出来的小树（selftest/lib/type-hoist-tree.mjs）：两个工程装的 @types/react 不是同一份；
// 应用继承仓库里真的那份 React 19 预设，却自己写了一条 paths（只有 @/* 别名），把预设里钉 React 类型的几行整体顶掉了，
// 组件库的 import "react" 于是又得到提升目录里去找。
// 提升目录里放的恰好是应用自己的那个大版本：这时 tsc 是绿的，检查照样必须失败，要拦的是“取决于提升”。
// 检查脚本被改成空转，或改成只在这一次解析错了才报时，这一例会红。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildTree } from "../lib/type-hoist-tree.mjs";

export default {
  gate: "类型解析不靠提升（check:type-hoist）",
  mutation: "应用自己写的 paths 顶掉了预设里钉 React 类型的几行，提升的恰好是它自己的那个大版本",
  reason: /apps\/web: @types\/react 经私有提升目录解析，而各工程自己装的不是同一份/,
  run(ctx) {
    const manifest = JSON.parse(readFileSync(join(ctx.repoRoot, "package.json"), "utf8"));
    const script = manifest.scripts?.["check:type-hoist"];
    if (script !== "node infra/ci/check-type-hoist.mjs") {
      throw new Error(
        `根脚本 check:type-hoist 不是 node infra/ci/check-type-hoist.mjs，现在是：${script}`,
      );
    }
    const [, file] = script.split(" ");
    const dir = ctx.tempDir();
    buildTree(dir, {
      tsconfig: {
        extends: join(ctx.repoRoot, "packages/config/tsconfig/web-react19.json"),
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
      },
      own: "19.0.0",
      hoisted: "19.0.0",
    });
    return ctx.node(file, ["--root", dir]);
  },
};
