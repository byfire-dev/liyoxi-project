// 当前模型一致性反例：真实迁移库变了列类型，Prisma只读diff必须输出纠正DDL并令原required门禁失败。
import { join } from "node:path";
import { dropDb, recreateDb, sqlOrThrow } from "../../db-lib.mjs";
import { applyMigrations } from "../../db-structure-lib.mjs";

export default {
  gate: "现行库与 Prisma schema 一致（db:catalog-diff）",
  mutation: "现行迁移库 biz_sequence.next_val 改为 bigint，模型仍是 Int",
  reason:
    /库与现行 schema 不一致：[\s\S]*ALTER TABLE "biz_sequence" ALTER COLUMN "next_val"[\s\S]*INTEGER[\s\S]*系统目录比对未通过/,
  run(ctx) {
    const ref = `lyx_selftest_schema_${process.pid}`;
    const mutated = `${ref}_mutated`;
    try {
      recreateDb(ref);
      applyMigrations(ref);
      recreateDb(mutated, { template: ref });
      sqlOrThrow(mutated, "ALTER TABLE biz_sequence ALTER COLUMN next_val TYPE bigint");
      const result = ctx.node("infra/ci/db-catalog-diff.mjs", [
        "--ref",
        ref,
        "--target",
        mutated,
        "--report",
        join(ctx.tempDir(), "report.md"),
      ]);
      if (result.status === 2) throw new Error("当前模型反例的证明未执行成功，不算门禁拦截");
      return result;
    } finally {
      dropDb(mutated);
      dropDb(ref);
    }
  },
};
