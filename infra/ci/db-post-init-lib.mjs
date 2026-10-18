// 首版冻结证明与现行 Prisma 模型核对。仅命令行门禁使用，不新增运行时依赖。
// 首版：冻结草稿离线出 DDL + 00–15 约束，与只跑 init 的库逐项比较；两个临时库 finally 删除。
// 现行：ADR-045 的库 → schema migrate diff，只读目标库；唯一已确认的假动作是素材三元组索引。
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  CATEGORIES,
  countReport,
  diffRows,
  dropDb,
  pgEnv,
  readCatalog,
  recreateDb,
  sqlOrThrow,
} from "./db-lib.mjs";
import { repoRoot } from "./db-structure-lib.mjs";

const INIT = "packages/db/prisma/migrations/20261005000000_init/migration.sql";
const KNOWN_INDEX_DIFF = 'DROP INDEX "ix_store_asset_search";';

/** Prisma stderr 可能包含连接信息，不回显；SQL 成果不含连接参数。 */
function prisma(root, args, databaseUrl) {
  const pkg = join(root, "packages/db");
  const result = spawnSync(
    join(pkg, "node_modules/.bin/prisma"),
    ["migrate", "diff", ...args, "--script"],
    {
      cwd: pkg,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: databaseUrl, CHECKPOINT_DISABLE: "1" },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Prisma migrate diff 未成功，连接与工具诊断不回显");
  const start = result.stdout.indexOf("--");
  if (start < 0) throw new Error("Prisma migrate diff 未返回可识别的 SQL");
  return result.stdout.slice(start).split("┌")[0];
}

/** 保持 psql 与 Prisma 同一实际端点；连接串只进入子进程环境变量。 */
function targetUrl(db) {
  const env = { ...process.env, ...pgEnv() };
  const url = new URL("postgresql://localhost/");
  if (env.PGHOST?.startsWith("/")) url.searchParams.set("host", env.PGHOST);
  else url.hostname = env.PGHOST || "localhost";
  url.port = env.PGPORT || "5432";
  url.username = env.PGUSER || "";
  url.password = env.PGPASSWORD || "";
  url.pathname = `/${db}`;
  if (env.PGSSLMODE) url.searchParams.set("sslmode", env.PGSSLMODE);
  return url.toString();
}

/** 只有完整且唯一的一条已知 DROP 可忽略；相同名字旁的任何新动作仍拒绝。 */
export function schemaDiffProblems(sql) {
  const ddl = sql.replace(/^\s*--[^\n]*(?:\n|$)/gm, "").trim();
  if (ddl === "" || ddl === KNOWN_INDEX_DIFF) return [];
  return [`库与现行 schema 不一致：${ddl}`];
}

export function currentSchemaProblems(db, { root = repoRoot } = {}) {
  return schemaDiffProblems(
    prisma(
      root,
      ["--from-config-datasource", "--to-schema", "prisma/schema.prisma"],
      targetUrl(db),
    ),
  );
}

/** 原固定首版数量只用于首版证明；不拿它约束未来完整迁移。 */
export function frozenInitProof({ root = repoRoot } = {}) {
  const ddl = prisma(
    root,
    ["--from-empty", "--to-schema", join(root, "docs/data-model/schema.prisma")],
    "postgresql://offline.invalid/unused",
  );
  if (!/^CREATE TABLE /m.test(ddl)) throw new Error("冻结草稿未生成任何表");
  const constraintsDir = join(root, "docs/data-model/constraints");
  const files = readdirSync(constraintsDir)
    .filter((name) => /^\d\d-.+\.sql$/.test(name))
    .sort();
  if (files.length !== 16) throw new Error("冻结约束必须仍为 00–15 共 16 份");
  const draftDb = `lyx_test_infra_init_draft_${process.pid}`;
  const initDb = `lyx_test_infra_init_migrate_${process.pid}`;
  const created = [];
  let result;
  let failure;
  try {
    for (const db of [draftDb, initDb]) {
      recreateDb(db);
      created.push(db);
    }
    sqlOrThrow(draftDb, ddl);
    for (const file of files) sqlOrThrow(draftDb, readFileSync(join(constraintsDir, file), "utf8"));
    sqlOrThrow(initDb, `begin;\n${readFileSync(join(root, INIT), "utf8")}\ncommit;`);
    const draft = readCatalog(draftDb);
    const init = readCatalog(initDb);
    const problems = CATEGORIES.flatMap(([id, label]) =>
      diffRows(draft[id], init[id]).map((problem) => `【${label}】${problem}`),
    );
    if (![draft.version, init.version].every((version) => version.startsWith("17.")))
      problems.push("首版证明的两个库都要在 PostgreSQL 17 上");
    const counts = countReport([
      ["冻结草稿", draft],
      ["首版迁移", init],
    ]);
    result = { problems: [...problems, ...counts.problems], lines: counts.lines };
  } catch (error) {
    failure = error;
  } finally {
    for (const db of created.reverse()) {
      try {
        dropDb(db);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
  return result;
}
