// W0-05 的门禁：系统目录比对（pnpm db:catalog-diff）。迁移库上删一条 CHECK 之后，比对必须失败，并指出是哪一条。
// 不碰共享的 lyx_schema_check、lyx_migrate_check：用全部迁移另建一个库当参照，再拷一份出来删掉一条 CHECK，
// 两个库用完都删。比对脚本不再比约束、或只比数量不比定义时，这一例会红。
// 要本地那套 PostgreSQL 在运行（pnpm infra:up），并给出 DATABASE_URL 或 PG* 环境变量（CLAUDE.md 第 9 节）；
// 连不上时这一例会红，不会被悄悄跳过。
import { join } from "node:path";

import { dropDb, recreateDb, sqlOrThrow } from "../../db-lib.mjs";

import { applyMigrations } from "../../db-structure-lib.mjs";
const CONSTRAINT = "ck_idempotency_record_state";

export default {
  gate: "系统目录比对（db:catalog-diff）",
  mutation: `迁移库上删一条 CHECK（idempotency_record 的 ${CONSTRAINT}）`,
  reason: new RegExp(
    `【约束定义】idempotency_record\\.${CONSTRAINT}：参照库有，迁移库没有[\\s\\S]*系统目录比对未通过`,
  ),
  run(ctx) {
    const ref = `lyx_selftest_catdiff_${process.pid}`;
    const mutated = `${ref}_mutated`;
    try {
      recreateDb(ref);
      applyMigrations(ref);
      recreateDb(mutated, { template: ref });
      sqlOrThrow(mutated, `ALTER TABLE idempotency_record DROP CONSTRAINT ${CONSTRAINT}`);
      const report = join(ctx.tempDir(), "report.md");
      const result = ctx.node("infra/ci/db-catalog-diff.mjs", [
        ...["--ref", ref, "--target", mutated, "--report", report],
      ]);
      // 退出码 2 是环境问题（连不上库），不算“检查失败”
      if (result.status === 2)
        throw new Error(result.output.trim().split("\n").slice(-2).join(" "));
      return result;
    } finally {
      dropDb(mutated);
      dropDb(ref);
    }
  },
};
