import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, makeTempRepo, repoRoot, run, writeFiles } from "./helpers.js";

const script = join(repoRoot, "infra/ci/check-rename.mjs");

// 旧名用拼接写出：字面量入库的话，换名检查会把本文件判中
const OLD = ["li", "yo"].join("");
const OLD_WEAPP_DIR = ["apps", "mobile"].join("/");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** 在临时 git 仓库里放一批文件，跑换名检查 */
function check(files: Record<string, string>, untracked: Record<string, string> = {}) {
  const temp = makeTempRepo("lyx-rename-", files);
  cleanups.push(temp.cleanup);
  writeFiles(temp.dir, untracked);
  return run("node", [script], temp.dir);
}

describe("干净树通过", () => {
  it("本仓库通过", () => {
    const result = run("node", [script], repoRoot);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("新名不误报", () => {
    const result = check({
      "package.json": '{\n  "name": "liyoxi"\n}\n',
      "packages/x/package.json": '{\n  "name": "@liyoxi/x"\n}\n',
      "infra/env.sh": "export LIYOXI_HOME=/opt/liyoxi\n",
      "README.md": "# 狸有戏（Liyoxi）\n",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("换名检查通过");
  });

  it("docs/ 与 design/ 里的旧名不算", () => {
    const result = check({
      "docs/02-tech-selection.md": `参考工程的包作用域是 @${OLD}/*\n`,
      "design/notes.md": `样式变量原来叫 $${OLD}-color\n`,
      "src/index.ts": "export const ok = true;\n",
    });
    expect(result.status).toBe(0);
  });

  it("完整性哈希里碰巧出现的字母不算", () => {
    const hash = `sha512-AbC${OLD.toUpperCase()}dEf${OLD}+/0123456789==`;
    const result = check({
      "pnpm-lock.yaml": `packages:\n\n  some-pkg@1.0.0:\n    resolution: {integrity: ${hash}}\n`,
    });
    expect(result.status).toBe(0);
  });
});

describe("出现旧名即失败，并指出文件与行", () => {
  it.each([
    ["包作用域", `@${OLD}/x`],
    ["进程名", `${OLD}-api`],
    ["样式变量", `$${OLD}-color`],
    ["大写的环境变量", `${OLD.toUpperCase()}_HOME`],
  ])("%s：%s", (_label, oldName) => {
    const result = check({
      "ok.txt": "liyoxi\n",
      "packages/x/config.txt": `第一行\n第二行\n名字 = ${oldName}\n`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/x/config.txt:3:");
    expect(result.stderr).toContain(oldName);
    expect(result.stderr).not.toContain("ok.txt");
  });

  it("同一行里新名旧名都有：只报旧名", () => {
    const result = check({ "a.txt": `@liyoxi/x 与 @${OLD}/x\n` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("共 1 处");
    expect(result.stderr).toContain("a.txt:1:14:");
  });

  it("路径里有旧名", () => {
    const result = check({ [`infra/${OLD}-api.conf`]: "listen 80;\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`infra/${OLD}-api.conf: 路径里有旧名`);
  });

  it("还没加入暂存区、也没被忽略的文件同样要查", () => {
    const result = check({ "ok.txt": "liyoxi\n" }, { "new.txt": `${OLD}-worker\n` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("new.txt:1:");
  });

  it("被忽略的文件不查", () => {
    const result = check({ ".gitignore": "dist/\n" }, { "dist/out.js": `"${OLD}-api";\n` });
    expect(result.status).toBe(0);
  });
});

describe("小程序目录叫 apps/weapp", () => {
  it(`出现 ${OLD_WEAPP_DIR} 目录即失败`, () => {
    const result = check({ [`${OLD_WEAPP_DIR}/src/app.ts`]: "export const ok = true;\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${OLD_WEAPP_DIR}/src/app.ts: 小程序目录应为 apps/weapp`);
  });

  it(`${OLD_WEAPP_DIR} 目录里只有被忽略的文件，也算出现`, () => {
    const result = check(
      { ".gitignore": "dist/\n" },
      { [`${OLD_WEAPP_DIR}/dist/app.js`]: "export const ok = true;\n" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${OLD_WEAPP_DIR}/: 小程序目录应为 apps/weapp`);
  });

  it("apps/weapp 目录通过", () => {
    const result = check({ "apps/weapp/src/app.ts": "export const ok = true;\n" });
    expect(result.status).toBe(0);
  });
});

describe("环境不对时报用法错误", () => {
  it("不在 git 仓库里跑，退出码 2", () => {
    const temp = makeTempDir("lyx-rename-");
    cleanups.push(temp.cleanup);
    const result = run("node", [script], temp.dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("须是 git 仓库的根目录");
  });
});
