import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// 首版迁移是拼出来的（scripts/build-init-migration.mjs）：重拼的结果要与入库的文件逐字节相同。离线，不连库。

const pkg = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(pkg, "../..");
const MIGRATION = "prisma/migrations/20261005000000_init/migration.sql";
const SCRIPT = "scripts/build-init-migration.mjs";
const FOUR_KINDS = /\b(DROP|RENAME)\b|\bSET NOT NULL\b|\bALTER COLUMN \S+ (SET DATA )?TYPE\b/;

const check = (root: string) =>
  spawnSync(process.execPath, [join(root, SCRIPT), "--check"], { encoding: "utf8" });

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** 仓库外的一份最小副本：本包的 schema、迁移、脚本、配置与底稿的 constraints/；依赖用符号链接指回来 */
function copyOfPackage(): string {
  const dir = mkdtempSync(join(tmpdir(), "lyx-db-migration-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const copy = join(dir, "packages/db");
  for (const path of ["prisma", "scripts", "prisma.config.ts", "package.json"]) {
    cpSync(join(pkg, path), join(copy, path), { recursive: true });
  }
  symlinkSync(join(pkg, "node_modules"), join(copy, "node_modules"), "dir");
  const constraints = "docs/data-model/constraints";
  cpSync(join(repoRoot, constraints), join(dir, constraints), { recursive: true });
  return copy;
}

describe("首版迁移", () => {
  it(
    "重拼的结果与入库的迁移逐字节相同；带 lyx:allow 的语句是登记的那 6 条",
    { timeout: 60_000 },
    () => {
      const result = check(pkg);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("重拼的结果与入库的迁移逐字节相同");
      expect(result.stdout).toContain(
        "带 lyx:allow 的语句 6 条：DROP 1，RENAME 1，ALTER … TYPE 0，不带默认值的 SET NOT NULL 4",
      );
    },
  );

  it("入库的迁移被手改过一处：核对失败，指出从哪一行起不同", { timeout: 60_000 }, () => {
    const copy = copyOfPackage();
    expect(check(copy).status).toBe(0);
    const file = join(copy, MIGRATION);
    const lines = readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex((line) => line.includes("ck_idempotency_record_state"));
    expect(at).toBeGreaterThan(0);
    lines[at] = `${lines[at]} `;
    writeFileSync(file, lines.join("\n"));
    const result = check(copy);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`重拼的结果与入库的迁移不同（第 ${at + 1} 行起）`);
  });

  it("底稿里多出一条没登记理由的四类语句：拼接报错，不让它漏标", { timeout: 60_000 }, () => {
    const copy = copyOfPackage();
    const draft = join(copy, "../../docs/data-model/constraints/15-integration-ops.sql");
    writeFileSync(draft, `${readFileSync(draft, "utf8")}DROP INDEX ix_lyx_selftest_only;\n`);
    const result = check(copy);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("属于要带 lyx:allow 的四类，但没有登记理由：DROP INDEX");
  });

  it("每一行 lyx:allow 都带理由，后面紧跟的是四类语句之一；四类语句前面都有它", () => {
    const lines = readFileSync(join(pkg, MIGRATION), "utf8").split("\n");
    const marked = lines.flatMap((line, index) => (line.startsWith("-- lyx:allow") ? [index] : []));
    expect(marked).toHaveLength(6);
    for (const index of marked) {
      expect(lines[index]).toMatch(/^-- lyx:allow \S.{10,}$/);
      expect(lines[index + 1]).toMatch(FOUR_KINDS);
    }
    const statements = lines.flatMap((line, index) =>
      !line.trimStart().startsWith("--") && FOUR_KINDS.test(line) ? [index] : [],
    );
    // 35 条 SET NOT NULL 里 31 条的列带默认值，不用标；其余 4 条与 RENAME、DROP 各 1 条要标
    expect(statements).toHaveLength(37);
    const unmarked = statements.filter((index) => !marked.includes(index - 1));
    expect(unmarked).toHaveLength(31);
    for (const index of unmarked) expect(lines[index]).toMatch(/ SET NOT NULL;$/);
  });
});
