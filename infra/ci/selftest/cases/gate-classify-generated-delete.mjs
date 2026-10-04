// 门禁改动分类的 generated 口径（入库的生成物）：重新生成算只增，删掉一份已有的生成物算放松。
// 用的是仓库里真实的清单：工作包 PR 删掉一份契约生成物、同时重新生成另一份，没有 gate-change 标签必须失败。
// 清单里这个目录的条目被拿掉、或又被 except 整个盖住（那样删生成物分类不报）时，这一例会红；
// 分类脚本不再把删除判成放松时也会红。
const GENERATED = "packages/contract/generated";
const DOCUMENT = `${JSON.stringify({ openapi: "3.1.0", paths: {} }, null, 2)}\n`;

export default {
  gate: "门禁改动分类（生成物）",
  mutation: "工作包 PR 删掉一份已有的契约生成物，没有 gate-change 标签",
  reason:
    /`packages\/contract\/generated\/portal\.openapi\.json`：删除了门禁文件\n[\s\S]*`packages\/contract\/generated\/merchant\.openapi\.json`：重新生成的生成物，内容有变[^\n]*`pnpm contract:check` 把关[\s\S]*没有 gate-change 标签/,
  run(ctx) {
    const dir = ctx.gitRepo({
      [`${GENERATED}/merchant.openapi.json`]: DOCUMENT,
      [`${GENERATED}/portal.openapi.json`]: DOCUMENT,
    });
    ctx.git(dir, "commit", "-q", "-m", "base");
    ctx.git(dir, "rm", "-q", `${GENERATED}/portal.openapi.json`);
    ctx.writeFiles(dir, {
      [`${GENERATED}/merchant.openapi.json`]: DOCUMENT.replace(
        '"paths": {}',
        '"paths": { "/v1/x": {} }',
      ),
    });
    ctx.git(dir, "add", "-A");
    ctx.git(dir, "commit", "-q", "-m", "head");
    return ctx.node("infra/ci/classify-gate-changes.mjs", ["--base", "HEAD~1"], { cwd: dir });
  },
};
