// 门禁改动分类的 generated 口径（入库的生成物）：这个口径不逐行判，生成物与源码一致不一致全靠条目的
// check 写的那道检查。条目没写 check，就没有检查替它把关：判不出，按放松算，没有 gate-change 标签必须失败。
// 用一份临时清单（--gate-files）：一个目录按 generated 登记，却没写 check；再改这个目录下已有的一份生成物。
// 分类脚本不再要求 generated 条目写明检查命令时（任何目录登记成 generated 就等于不判），这一例会红。
import { join } from "node:path";

const GENERATED = "packages/db/snapshot";
const REGISTRY = { files: [{ pattern: `${GENERATED}/**`, kind: "generated" }] };

export default {
  gate: "门禁改动分类（生成物条目要写明检查命令）",
  mutation:
    "清单里的 generated 条目没写 check，工作包 PR 改了它名下的生成物，没有 gate-change 标签",
  reason:
    /`packages\/db\/snapshot\/schema\.sql`：条目 `packages\/db\/snapshot\/\*\*` 没有写明把关它的检查命令（check）[\s\S]*没有 gate-change 标签/,
  run(ctx) {
    const dir = ctx.gitRepo({ [`${GENERATED}/schema.sql`]: "create table a (id uuid);\n" });
    ctx.git(dir, "commit", "-q", "-m", "base");
    ctx.writeFiles(dir, { [`${GENERATED}/schema.sql`]: "create table a (id text);\n" });
    ctx.git(dir, "add", "-A");
    ctx.git(dir, "commit", "-q", "-m", "head");
    const registryDir = ctx.tempDir();
    ctx.writeFiles(registryDir, { "gate-files.json": `${JSON.stringify(REGISTRY, null, 2)}\n` });
    return ctx.node(
      "infra/ci/classify-gate-changes.mjs",
      ["--base", "HEAD~1", "--gate-files", join(registryDir, "gate-files.json")],
      { cwd: dir },
    );
  },
};
