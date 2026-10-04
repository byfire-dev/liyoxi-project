import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

// 托管库验证脚本的用例（W0-05 任务书 第 7 节第 9 条）：在本地那套共享的 PostgreSQL 上演练。
// 先 pnpm infra:up 并给出 DATABASE_URL（CLAUDE.md 第 9 节）；连不上即失败，不跳过。
// 只建、删自己的库 lyx_test_infra_managed_<进程号>。

interface DbLib {
  recreateDb(name: string): void;
  dropDb(name: string): void;
  sqlOrThrow(db: string, sql: string): string;
}
const lib = (await import(pathToFileURL(join(repoRoot, "infra/ci/db-lib.mjs")).href)) as DbLib;

const base = process.env.DATABASE_URL;
if (!base)
  throw new Error("DATABASE_URL 未设置：这份用例要连本地的 PostgreSQL（CLAUDE.md 第 9 节）");
const DB = `lyx_test_infra_managed_${process.pid}`;
const urlOf = (db: string) => Object.assign(new URL(base), { pathname: `/${db}` }).toString();
const password = new URL(base).password;

function verify(databaseUrl: string | undefined) {
  const { DATABASE_URL: _dropped, PGHOST: _host, ...rest } = process.env;
  const env = databaseUrl === undefined ? rest : { ...rest, DATABASE_URL: databaseUrl };
  const result = spawnSync("node", ["infra/ci/db-verify-managed.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterAll(() => lib.dropDb(DB));

describe("db-verify-managed.mjs", () => {
  it("没给 DATABASE_URL、库名不是 lyx_ 开头：退出码 2，什么都不动", () => {
    const missing = verify(undefined);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("托管库验证：没有连接参数");
    const wrongName = verify(base);
    expect(wrongName.status).toBe(2);
    expect(wrongName.stderr).toContain("DATABASE_URL 指的库名要以 lyx_ 开头");
  });

  it("连不上：退出码 2，报错里没有主机、账号、口令", () => {
    const result = verify("postgresql://lyx_user_x:s3cret-pw-x@127.0.0.1:1/lyx_none");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("托管库验证：连不上库，或语句没跑成");
    expect(result.stdout + result.stderr).not.toMatch(
      /lyx_user_x|s3cret-pw-x|127\.0\.0\.1|postgresql:/,
    );
  });

  it(
    "空库上演练：两个扩展可建、迁移跑通、数量对得上；输出里没有连接串。库不空时拒绝",
    { timeout: 120_000 },
    () => {
      lib.recreateDb(DB);
      const result = verify(urlOf(DB));
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`- 库：\`${DB}\`（空库）；PostgreSQL 17.`);
      expect(result.stdout).toMatch(/- 实例上可装的扩展：btree_gist [\d.]+、pg_trgm [\d.]+\n/);
      expect(result.stdout).toContain("- 迁移：跑通，已完成 1 个（20261005000000_init）");
      expect(result.stdout).toMatch(/- 迁移建出的扩展：btree_gist [\d.]+、pg_trgm [\d.]+\n/);
      expect(result.stdout).toContain("| 表 | 166 / 171 | 166 / 171 |");
      expect(result.stdout).toContain("| CHECK 约束 | 1234 / 1284 | 1234 / 1284 |");
      expect(result.stdout).toContain("结论：通过。两个扩展可建，迁移跑通，数量对得上");
      expect(result.stdout).not.toContain(password);
      expect(result.stdout).not.toMatch(/postgres(?:ql)?:\/\/|localhost|127\.0\.0\.1|:5442/);

      const again = verify(urlOf(DB));
      expect(again.status).toBe(2);
      expect(again.stderr).toMatch(
        /库 lyx_test_infra_managed_\d+ 里已经有 17[12] 张表：要一个空库/,
      );
    },
  );

  it(
    "迁移中途失败：退出码 1，给出迁移工具的输出，其中没有主机、端口、账号、口令",
    { timeout: 120_000 },
    () => {
      // 空库里先占掉迁移要建的一个序列名：库里没有表，过得了“空库”这一关，迁移跑到建序列那句失败
      lib.recreateDb(DB);
      lib.sqlOrThrow(DB, "CREATE SEQUENCE audit_no_seq");
      const result = verify(urlOf(DB));
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("- 迁移：没跑通。迁移工具的输出（连接信息已抹掉）：");
      expect(result.stdout).toContain("audit_no_seq");
      expect(result.stdout).toContain("结论：不通过。迁移没跑通");
      const { hostname, port, username } = new URL(base);
      const output = result.stdout + result.stderr;
      for (const secret of [hostname, `:${port}`, username, password, "postgresql:"]) {
        expect(secret.length).toBeGreaterThan(2);
        expect(output).not.toContain(secret);
      }
    },
  );
});
