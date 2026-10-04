import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { makeTempDir, repoRoot, run } from "./helpers.js";

const temp = makeTempDir("lyx-hooks-");
afterAll(() => temp.cleanup());

/** 照 husky 的做法（sh -e）跑仓库里的 commit-msg 钩子，传入一条提交信息 */
function commitMsg(message: string, name: string) {
  const messageFile = join(temp.dir, name);
  writeFileSync(messageFile, `${message}\n`);
  return run("sh", ["-e", ".husky/commit-msg", messageFile], repoRoot);
}

describe("提交钩子已安装", () => {
  it("安装后 core.hooksPath 指向 .husky/_", () => {
    const result = run("git", ["config", "--get", "core.hooksPath"], repoRoot);
    expect(result.stdout.trim()).toBe(".husky/_");
  });

  it("husky 生成了两个钩子的入口", () => {
    expect(existsSync(join(repoRoot, ".husky/_/pre-commit"))).toBe(true);
    expect(existsSync(join(repoRoot, ".husky/_/commit-msg"))).toBe(true);
  });
});

describe("pre-commit 调 lint-staged", () => {
  it("钩子里跑的是 lint-staged", () => {
    const hook = readFileSync(join(repoRoot, ".husky/pre-commit"), "utf8");
    expect(hook.trim()).toBe("pnpm lint-staged");
  });

  it("lint-staged 的配置对代码跑 eslint 与 prettier", () => {
    const config = JSON.parse(readFileSync(join(repoRoot, ".lintstagedrc.json"), "utf8")) as Record<
      string,
      string[]
    >;
    const commands = Object.values(config).flat();
    expect(commands.some((command) => command.startsWith("eslint --fix"))).toBe(true);
    expect(commands.some((command) => command.startsWith("prettier --write"))).toBe(true);
  });

  it("lint-staged 装上了，能读到配置", () => {
    const result = run("pnpm", ["exec", "lint-staged", "--version"], repoRoot);
    expect(result.status).toBe(0);
  });
});

describe("commit-msg 调 commitlint", () => {
  it("钩子里跑的是 commitlint", () => {
    const hook = readFileSync(join(repoRoot, ".husky/commit-msg"), "utf8");
    expect(hook.trim()).toBe('pnpm commitlint --edit "$1"');
  });

  it("bad message 被拒", () => {
    const result = commitMsg("bad message", "bad.txt");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("type-empty");
    expect(result.output).toContain("subject-empty");
  });

  it("feat(config): 根骨架 通过", () => {
    const result = commitMsg("feat(config): 根骨架", "good.txt");
    expect(result.output).not.toContain("✖");
    expect(result.status).toBe(0);
  });

  it("工作包编号放句末的写法通过", () => {
    expect(commitMsg("feat(config): 根骨架（W0-01）", "numbered.txt").status).toBe(0);
  });

  it("以大写拉丁字母开头的一句话被拒", () => {
    const result = commitMsg("feat(config): Root skeleton", "upper.txt");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("subject-case");
  });
});
