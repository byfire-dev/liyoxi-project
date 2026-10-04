import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { git, makeTempRepo, repoRoot, run } from "./helpers.js";

// design:check = 重新生成 + git diff --exit-code -- packages/shared/src/design/generated（根 package.json）。
// 这里在仓库外的临时仓库里走同样的两步，不碰本仓库的工作区。
const GENERATED = "packages/shared/src/design/generated";

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

/** 走 design:check 的两步：重新生成到临时仓库，再看有没有差异 */
function designCheck(dir: string) {
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
  expect(generate.stderr).toBe("");
  expect(generate.status).toBe(0);
  return run("git", ["diff", "--exit-code", "--stat", "--", GENERATED], dir);
}

describe("生成物无差异检查", () => {
  it("根脚本 design:check 就是这两步", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["design:check"]).toBe(
      `pnpm design:generate && git diff --exit-code -- ${GENERATED}`,
    );
  });

  it("入库的生成物原样：重新生成后没有差异", () => {
    const result = designCheck(repoWithGenerated());
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
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
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${GENERATED}/merchant.scss`);
    expect(result.stdout).not.toContain("admin.scss");
  });
});
