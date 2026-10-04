// W0-08 的门禁：contract:check（契约生成物与源码无差异）。改了契约源码却没重新生成，检查必须失败。
// 不动本仓库的文件：在仓库外造一份最小副本——根 package.json、pnpm-workspace.yaml、packages/contract
//（不带 node_modules）、packages/config/tsconfig（契约包的 tsconfig 继承它）；依赖用符号链接指回本仓库装好的那份。
// 副本里先生成一遍并加入暂存区作基线（不依赖本仓库此刻的生成物新不新），再给通用结构 DictRef 加一个字段、
// 不重新生成，然后照 CI 里那一步实际的命令跑。
// 提交的生成物里只有 DictRef、ErrorBody、SentryEnvelope 三个组件（样例路由只是测试夹具，不进生成物），
// 所以要改这三个结构之一：改别的结构，生成物不变，contract:check 自己不会红。
// CI 的 verify 里没有了 contract:check 那一步、或根脚本不再比对生成物时，这一例会红。
// 要 pnpm 在 PATH 上、本仓库的依赖已安装（CI 里排在冻结安装之后）。
import { cpSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONTRACT = "packages/contract";
const STRUCTURES = `${CONTRACT}/src/common/structures.ts`;
/** DictRef 这个组件名由约定 C87 定，源码里登记它的写法就是这一段 */
const ANCHOR = '.openapi("DictRef")';
const FIELD = "lyxSelftestOnly";

export default {
  gate: "contract:check（契约生成物与源码无差异）",
  mutation: "给通用结构 DictRef 加一个字段，不重新生成",
  // git diff 的输出：三份文档里都多出这个字段
  reason: new RegExp(
    `^diff --git a/${CONTRACT}/generated/\\S+\\.openapi\\.json [\\s\\S]*^\\+ +"${FIELD}": \\{$`,
    "m",
  ),
  run(ctx) {
    const read = (path) => readFileSync(join(ctx.repoRoot, path), "utf8");
    const step = read(".github/workflows/ci.yml").match(
      /^ {6}- name: .+\n {8}run: (pnpm contract:check)$/m,
    );
    if (!step) throw new Error("ci.yml 的 verify 里找不到“run: pnpm contract:check”那一步");
    const [tool, ...args] = step[1].split(" ");

    const dir = ctx.tempDir();
    ctx.git(dir, "init", "-q", "-b", "main");
    ctx.writeFiles(dir, {
      ".gitignore": "node_modules\n",
      "package.json": read("package.json"),
      "pnpm-workspace.yaml": read("pnpm-workspace.yaml"),
    });
    cpSync(join(ctx.repoRoot, "packages/config/tsconfig"), join(dir, "packages/config/tsconfig"), {
      recursive: true,
    });
    cpSync(join(ctx.repoRoot, CONTRACT), join(dir, CONTRACT), {
      recursive: true,
      filter: (source) => !source.endsWith("/node_modules"),
    });
    symlinkSync(
      join(ctx.repoRoot, CONTRACT, "node_modules"),
      join(dir, CONTRACT, "node_modules"),
      "dir",
    );

    const baseline = ctx.run("pnpm", ["contract:generate"], { cwd: dir });
    if (baseline.status !== 0) throw new Error(`副本里的基线没生成出来：${baseline.output.trim()}`);
    ctx.git(dir, "add", "-A");

    const source = readFileSync(join(dir, STRUCTURES), "utf8");
    if (!source.includes(ANCHOR)) throw new Error(`${STRUCTURES} 里找不到 ${ANCHOR}`);
    writeFileSync(
      join(dir, STRUCTURES),
      source.replace(ANCHOR, `.extend({ ${FIELD}: z.string() })${ANCHOR}`),
    );
    ctx.git(dir, "add", "-A");
    return ctx.run(tool, args, { cwd: dir });
  },
};
