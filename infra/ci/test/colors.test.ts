import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, repoRoot, run, writeFiles } from "./helpers.js";

const script = join(repoRoot, "infra/ci/check-colors.mjs");
const fixtures = join(repoRoot, "infra/ci/fixtures/colors");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** 在临时目录里放一批文件，对它跑检查；白名单为空 */
function check(files: Record<string, string>, allowlist = "") {
  const temp = makeTempDir("lyx-colors-");
  cleanups.push(temp.cleanup);
  writeFiles(temp.dir, { ...files, "allowlist.txt": allowlist });
  return run(
    "node",
    [script, "--root", temp.dir, "--allowlist", join(temp.dir, "allowlist.txt")],
    repoRoot,
  );
}

describe("干净仓库通过", () => {
  it("本仓库通过，白名单初始为空", () => {
    const result = run("node", [script], repoRoot);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("页面色值检查通过");
    expect(result.stdout).toContain("放行 0 个");
  });
});

describe("反例：页面夹具写色值（门禁自测）", () => {
  const result = run("node", [script, "--root", join(fixtures, "bad")], repoRoot);

  it("检查失败", () => {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("共 4 处");
  });

  it.each([
    ["十六进制", "apps/weapp/src/pages/order/index.scss:6:12: 写了色值 #a63f12"],
    ["rgb()", "apps/admin/src/pages/orders/index.tsx:3:11: 写了色值 rgb(…)"],
    ["rgba()", "apps/portal/src/styles/page.css:7:15: 写了色值 rgba(…)"],
    ["hsl()", "apps/weapp/src/pages/mine/index.ts:2:37: 写了色值 hsl(…)"],
  ])("%s：指出文件与行", (_label, located) => {
    expect(result.stderr).toContain(located);
  });
});

describe("放行", () => {
  const allowed = join(fixtures, "allowed");

  it("生成物目录与白名单内的路径放行；注释里的色值不算", () => {
    const result = run(
      "node",
      [script, "--root", allowed, "--allowlist", join(allowed, "colors-allowlist.txt")],
      repoRoot,
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("扫了 2 个文件");
    expect(result.stdout).toContain("放行 2 个");
  });

  it("不在白名单里就拦：同一棵树换成空白名单即失败", () => {
    const result = run("node", [script, "--root", allowed], repoRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apps/weapp/src/components/cover/index.scss:3:10");
    expect(result.stderr).not.toContain("generated");
  });

  it("白名单按目录放行时只放那个目录", () => {
    const files = {
      "apps/weapp/src/legacy/a.scss": ".a { color: #123456; }\n",
      "apps/weapp/src/legacy-new/b.scss": ".b { color: #123456; }\n",
    };
    const result = check(files, "apps/weapp/src/legacy/\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apps/weapp/src/legacy-new/b.scss:1:13");
    expect(result.stderr).not.toContain("legacy/a.scss");
  });
});

describe("口径", () => {
  it.each([
    ["三位十六进制", "a.scss", ".a { color: #fff; }\n", "#fff"],
    ["带透明度的八位十六进制", "a.css", ".a { color: #1D1A16CC; }\n", "#1D1A16CC"],
    ["hsla()", "a.scss", ".a { color: hsla(0, 0%, 0%, 0.5); }\n", "hsla(…)"],
    ["大写的 RGB()", "a.css", ".a { color: RGB(0 0 0); }\n", "RGB(…)"],
    ["行内 style", "a.tsx", 'export const s = { color: "#C4501B" };\n', "#C4501B"],
    ["模板字符串", "a.ts", "export const s = `border: 1px solid #E7E1D8`;\n", "#E7E1D8"],
  ])("%s 被拦下", (_label, name, content, found) => {
    const result = check({ [`apps/admin/src/pages/${name}`]: content });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`apps/admin/src/pages/${name}:1:`);
    expect(result.stderr).toContain(`写了色值 ${found}`);
  });

  it.each([
    [
      "样式变量与插值",
      "a.scss",
      ".a { color: $lyx-color-primary; width: calc(100% - #{$gap}); }\n",
    ],
    ["行注释里的色值", "a.scss", "// 原型写的是 #C4501B\n.a { margin: 0; }\n"],
    ["块注释里的色值", "a.css", "/* 原型写的是 rgba(0, 0, 0, 0.35) */\n.a { margin: 0; }\n"],
    ["代码注释里的编号", "a.ts", "// 见 PR #123\nexport const a = 1;\n"],
    ["锚点与 HTML 实体", "a.tsx", 'export const a = ["#top", "&#8212;", "#/pages/home"];\n'],
    ["id 选择器", "a.scss", "#app { margin: 0; }\n"],
  ])("%s 不误报", (_label, name, content) => {
    const result = check({ [`apps/weapp/src/pages/${name}`]: content });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("只扫三个前端的 src；别的目录与别的扩展名不扫", () => {
    const result = check({
      "apps/api/src/a.ts": 'export const a = "#C4501B";\n',
      "packages/shared/src/a.ts": 'export const a = "#C4501B";\n',
      "apps/admin/src/a.json": '{ "color": "#C4501B" }\n',
      "apps/admin/src/node_modules/x/a.css": ".a { color: #fff; }\n",
      "apps/portal/src/ok.ts": "export const a = 1;\n",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("扫了 1 个文件");
  });

  it("不认识的参数、找不到白名单：退出码 2", () => {
    expect(run("node", [script, "--oops"], repoRoot).status).toBe(2);
    expect(run("node", [script, "--allowlist", "/no/such/file"], repoRoot).status).toBe(2);
  });
});
