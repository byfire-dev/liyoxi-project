// W0-12 的门禁：状态机迁移表对照（pnpm machines:check）。迁移表里删掉一行，对照必须失败，并指出分组文档的哪一行没有对应。
// 不动本仓库的文件：在仓库外造一份最小副本——根 package.json、pnpm-workspace.yaml、packages/shared
//（不带 node_modules，依赖用符号链接指回本仓库装好的那份；契约经它走到本仓库的 packages/contract）、
// packages/config/tsconfig、数据模型的分组文档与 catalogue.json。
// 副本里从迁移表删掉一行，照 CI 里那一步实际的命令跑。
// 删哪一行不写死（迁移表会随各域的包改动）：按文件名排序取第一份迁移表，取其中第一条“单占一行、ref 在本文件只出现一次”的迁移。
// CI 的 verify 里没有了 machines:check 那一步、根脚本不再对照、或对照不再逐行认领文档的行时，这一例会红。
// 要 pnpm 在 PATH 上、本仓库的依赖已安装（CI 里排在冻结安装之后）。不连库。
import { cpSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SHARED = "packages/shared";
const MACHINES = `${SHARED}/src/machines`;
/** 迁移表里单占一行的一条迁移：开头是 ref */
const ROW = /^ {2}\["(\d{2}:\d+)", .*\],$/;
const COPIED = ["package.json", "pnpm-workspace.yaml"];

/** 在副本里挑一行删掉，返回它的 ref 与所在文件 */
function dropOneRow(dir) {
  const files = readdirSync(join(dir, MACHINES))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
  for (const name of files) {
    const path = join(dir, MACHINES, name);
    const lines = readFileSync(path, "utf8").split("\n");
    const refs = lines.map((line) => ROW.exec(line)?.[1]);
    // 至少还剩两行：删掉之后这张表仍被别的行认领，红的只能是“文档这一行没有对应”
    if (refs.filter(Boolean).length < 3) continue;
    const index = refs.findIndex(
      (ref) => ref !== undefined && refs.filter((other) => other === ref).length === 1,
    );
    if (index < 0) continue;
    writeFileSync(path, lines.filter((_, at) => at !== index).join("\n"));
    return { ref: refs[index], file: `${MACHINES}/${name}` };
  }
  throw new Error(`${MACHINES} 下找不到可删的迁移行（单占一行、ref 只出现一次）`);
}

export default {
  gate: "状态机迁移表对照（machines:check）",
  mutation: "迁移表里删掉一行，分组文档不动",
  reason: /状态机迁移表对照未通过[\s\S]*：文档有而迁移表没有：\d{2}:\d+（事件码 [a-z0-9_.、]+）/,
  run(ctx) {
    const read = (path) => readFileSync(join(ctx.repoRoot, path), "utf8");
    const step = read(".github/workflows/ci.yml").match(
      /^ {6}- name: .+\n {8}run: (pnpm machines:check)$/m,
    );
    if (!step) throw new Error("ci.yml 的 verify 里找不到“run: pnpm machines:check”那一步");
    const [tool, ...args] = step[1].split(" ");

    const dir = ctx.tempDir();
    ctx.writeFiles(dir, Object.fromEntries(COPIED.map((path) => [path, read(path)])));
    cpSync(join(ctx.repoRoot, "packages/config/tsconfig"), join(dir, "packages/config/tsconfig"), {
      recursive: true,
    });
    cpSync(join(ctx.repoRoot, "docs/data-model"), join(dir, "docs/data-model"), {
      recursive: true,
    });
    cpSync(join(ctx.repoRoot, SHARED), join(dir, SHARED), {
      recursive: true,
      filter: (source) => !source.endsWith("/node_modules") && !source.endsWith("/dist"),
    });
    symlinkSync(
      join(ctx.repoRoot, SHARED, "node_modules"),
      join(dir, SHARED, "node_modules"),
      "dir",
    );

    // 没改之前副本里的对照得是通过的：不然下面的失败说明不了问题
    const before = ctx.run(tool, args, { cwd: dir });
    if (before.status !== 0)
      throw new Error(
        `副本里没删行时对照就没过：${before.output.trim().split("\n").slice(-4).join(" ")}`,
      );

    const dropped = dropOneRow(dir);
    const result = ctx.run(tool, args, { cwd: dir });
    // 报的得是删掉的那一行，不是别的差异
    if (result.status > 0 && !result.output.includes(`文档有而迁移表没有：${dropped.ref}（`))
      throw new Error(
        `删的是 ${dropped.file} 的 ${dropped.ref}，对照没有指出它：${result.output.trim().split("\n").slice(-4).join(" ")}`,
      );
    return result;
  },
};
