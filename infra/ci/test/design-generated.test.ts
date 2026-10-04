import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { git, makeTempRepo, repoRoot, run } from "./helpers.js";

// design:check = 重新生成 + git diff --exit-code -- packages/shared/src/design/generated，再查这个目录下
// 没有未跟踪的文件（根 package.json）。这里在仓库外的临时仓库里走同样的三步，不碰本仓库的工作区。
const GENERATED = "packages/shared/src/design/generated";
const untrackedScript = join(repoRoot, "infra/ci/check-untracked.mjs");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** 建一个只含生成物目录的临时仓库（已入暂存区），可先手改其中一个文件 */
function repoWithGenerated(mutate?: (dir: string) => void) {
  const temp = makeTempRepo("lyx-design-", { "README.md": "生成物对账的临时仓库\n" });
  cleanups.push(temp.cleanup);
  cpSync(join(repoRoot, GENERATED), join(temp.dir, GENERATED), { recursive: true });
  mutate?.(temp.dir);
  git(temp.dir, "add", "-A");
  return temp.dir;
}

/**
 * 走 design:check 的三步：重新生成到临时仓库 → 看有没有差异 → 看有没有未跟踪的文件。
 * 返回在哪一步失败（都过了是 null）与那一步的输出。只看退出码：pnpm 自己往 stderr 打告警不算失败
 */
function designCheck(dir: string): { failedAt: string | null; output: string } {
  const generate = run(
    "pnpm",
    [
      "--filter",
      "@liyoxi/shared",
      "exec",
      "tsx",
      "scripts/generate.ts",
      "--no-preview",
      "--out",
    ].concat(join(dir, GENERATED)),
    repoRoot,
  );
  if (generate.status !== 0) return { failedAt: "generate", output: generate.output };
  const diff = run("git", ["diff", "--exit-code", "--stat", "--", GENERATED], dir);
  if (diff.status !== 0) return { failedAt: "diff", output: diff.output };
  const untracked = run("node", [untrackedScript, GENERATED], dir);
  if (untracked.status !== 0) return { failedAt: "untracked", output: untracked.output };
  return { failedAt: null, output: "" };
}

describe("生成物无差异检查", () => {
  it("根脚本 design:check 就是这三步", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["design:check"]).toBe(
      `pnpm design:generate && git diff --exit-code -- ${GENERATED} && node infra/ci/check-untracked.mjs ${GENERATED}`,
    );
  });

  it("入库的生成物原样：重新生成后没有差异，也没有未跟踪的文件", () => {
    expect(designCheck(repoWithGenerated())).toEqual({ failedAt: null, output: "" });
  });

  it("反例：手改一行生成物（门禁自测）", () => {
    const dir = repoWithGenerated((root) => {
      const file = join(root, GENERATED, "merchant.scss");
      const lines = readFileSync(file, "utf8").split("\n");
      const index = lines.findIndex((line) => line.startsWith("$lyx-radius-card:"));
      expect(index).toBeGreaterThan(0);
      lines[index] = "$lyx-radius-card: 15px;";
      writeFileSync(file, lines.join("\n"));
    });
    const result = designCheck(dir);
    expect(result.failedAt).toBe("diff");
    expect(result.output).toContain(`${GENERATED}/merchant.scss`);
    expect(result.output).not.toContain("admin.scss");
  });

  it("反例：生成物目录里多出一个手写文件，已暂存（git diff 看不出）", () => {
    const dir = repoWithGenerated((root) => {
      writeFileSync(join(root, GENERATED, "handwritten.scss"), "$lyx-mine: 1px;\n");
    });
    const result = designCheck(dir);
    expect(result.failedAt).toBe("generate");
    expect(result.output).toContain("不是脚本写的文件：handwritten.scss");
  });

  it("反例：有一个生成物没入库（git diff 看不出）", () => {
    const dir = repoWithGenerated();
    git(dir, "rm", "-q", "--cached", `${GENERATED}/tokens.ts`);
    const result = designCheck(dir);
    expect(result.failedAt).toBe("untracked");
    expect(result.output).toContain(`${GENERATED}/tokens.ts`);
    expect(result.output).not.toContain("merchant.scss");
  });
});

describe("生成物入库检查（check-untracked.mjs）", () => {
  it("没给目录、目录不存在：退出码 2", () => {
    expect(run("node", [untrackedScript], repoRoot).status).toBe(2);
    expect(run("node", [untrackedScript, "no/such/dir"], repoRoot).status).toBe(2);
  });

  it("被忽略的文件也算没跟踪", () => {
    const dir = repoWithGenerated((root) => {
      writeFileSync(join(root, ".gitignore"), "*.log\n");
    });
    writeFileSync(join(dir, GENERATED, "debug.log"), "x\n");
    const result = run("node", [untrackedScript, GENERATED], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${GENERATED}/debug.log`);
  });
});
