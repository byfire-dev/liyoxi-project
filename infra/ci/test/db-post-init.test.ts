import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, repoRoot, run } from "./helpers.js";

type Catalog = Record<string, unknown>;
const lib = (await import(pathToFileURL(join(repoRoot, "infra/ci/db-lib.mjs")).href)) as {
  recreateDb(db: string, options?: { template?: string }): void;
  dropDb(db: string): void;
  sqlOrThrow(db: string, sql: string): string;
  readCatalog(db: string): Catalog;
  countReport(
    named: [string, Catalog][],
    counts?: Record<string, number[]>,
  ): { problems: string[] };
  countsOf(catalog: Catalog): Record<string, [number, number]>;
};
const structure = (await import(
  pathToFileURL(join(repoRoot, "infra/ci/db-structure-lib.mjs")).href
)) as {
  applyMigrations(db: string): void;
  readSnapshot(): { counts: Record<string, [number, number]> };
  readStructure(db: string): unknown;
  renderSnapshot(value: unknown): string;
};
const proof = (await import(
  pathToFileURL(join(repoRoot, "infra/ci/db-post-init-lib.mjs")).href
)) as {
  frozenInitProof(options?: { root?: string }): { problems: string[]; lines: string[] };
  currentSchemaProblems(db: string, options?: { root?: string }): string[];
  schemaDiffProblems(sql: string): string[];
};
const base = `lyx_test_infra_postinit_${process.pid}`;
const copy = `${base}_copy`;
const temp = makeTempDir("lyx-postinit-proof-");
beforeAll(() => {
  lib.recreateDb(base);
  structure.applyMigrations(base);
}, 120_000);
afterAll(() => {
  lib.dropDb(copy);
  lib.dropDb(base);
  temp.cleanup();
});

describe("首版冻结证明与现行模型", () => {
  it(
    "全部迁移库与现行 snapshot、schema 相同；首版冻结草稿仍与仅 init 等价",
    { timeout: 120_000 },
    () => {
      expect(
        lib.countReport([["现行库", lib.readCatalog(base)]], structure.readSnapshot().counts)
          .problems,
      ).toEqual([]);
      expect(proof.currentSchemaProblems(base)).toEqual([]);
      const frozen = proof.frozenInitProof();
      expect(frozen.problems).toEqual([]);
      expect(frozen.lines).toContain("| 表 | 166 / 171 | 166 / 171 | 166 / 171 |");
    },
  );

  it("首版单独篡改函数体，即使现行库未改变，冻结证明也指向真差异", { timeout: 120_000 }, () => {
    const tree = join(temp.dir, "frozen");
    for (const path of [
      "docs/data-model/constraints",
      "docs/data-model/schema.prisma",
      "packages/db/prisma.config.ts",
      "packages/db/prisma/schema.prisma",
      "packages/db/prisma/migrations/20261005000000_init/migration.sql",
    ]) {
      mkdirSync(join(tree, path, ".."), { recursive: true });
      cpSync(join(repoRoot, path), join(tree, path), { recursive: true });
    }
    symlinkSync(
      join(repoRoot, "packages/db/node_modules"),
      join(tree, "packages/db/node_modules"),
      "dir",
    );
    const migration = join(tree, "packages/db/prisma/migrations/20261005000000_init/migration.sql");
    writeFileSync(
      migration,
      readFileSync(migration, "utf8") +
        "\nCREATE OR REPLACE FUNCTION lyx_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;\n",
    );
    expect(proof.frozenInitProof({ root: tree }).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("【函数体】lyx_forbid_update() 的 definition 不同"),
      ]),
    );
    writeFileSync(migration, readFileSync(migration, "utf8") + "\nSELECT 1 / 0;\n");
    expect(() => proof.frozenInitProof({ root: tree })).toThrow("division by zero");
    const ownNames = [
      `lyx_test_infra_init_draft_${process.pid}`,
      `lyx_test_infra_init_migrate_${process.pid}`,
    ];
    expect(
      lib
        .sqlOrThrow(
          "postgres",
          `SELECT count(*) FROM pg_database WHERE datname IN (${ownNames.map((name) => `'${name}'`).join(",")})`,
        )
        .trim(),
    ).toBe("0");
  });

  it("现行数据库列类型污染必须报真实 Prisma DDL，不能以冻结草稿正确掩盖", () => {
    lib.recreateDb(copy, { template: base });
    lib.sqlOrThrow(copy, "ALTER TABLE biz_sequence ALTER COLUMN next_val TYPE bigint");
    const problems = proof.currentSchemaProblems(copy);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ALTER TABLE "biz_sequence" ALTER COLUMN "next_val"');
    expect(problems[0]).toContain("INTEGER");
    expect(problems[0]).not.toMatch(/postgres(?:ql)?:\/\/|localhost|127\.0\.0\.1|5442/);
  });

  it(
    "现行新增合法表时不再要求166，当前模型/数量一致且首版证明仍固定166",
    { timeout: 120_000 },
    () => {
      lib.recreateDb(copy, { template: base });
      lib.sqlOrThrow(copy, 'CREATE TABLE "lyx_post_init" ("id" integer NOT NULL PRIMARY KEY)');
      const tree = join(temp.dir, "current");
      for (const path of [
        "packages/db/prisma.config.ts",
        "packages/db/prisma/schema.prisma",
        "docs/data-model/schema.prisma",
        "docs/data-model/constraints",
        "packages/db/prisma/migrations/20261005000000_init/migration.sql",
        "infra/ci/db-lib.mjs",
        "infra/ci/db-structure-lib.mjs",
        "infra/ci/db-post-init-lib.mjs",
        "infra/ci/db-catalog-diff.mjs",
      ]) {
        mkdirSync(join(tree, path, ".."), { recursive: true });
        cpSync(join(repoRoot, path), join(tree, path), { recursive: true });
      }
      symlinkSync(
        join(repoRoot, "packages/db/node_modules"),
        join(tree, "packages/db/node_modules"),
        "dir",
      );
      const schema = join(tree, "packages/db/prisma/schema.prisma");
      writeFileSync(
        schema,
        readFileSync(schema, "utf8") +
          '\nmodel PostInitProof {\n  id Int @id\n  @@map("lyx_post_init")\n}\n',
      );
      expect(proof.currentSchemaProblems(copy, { root: tree })).toEqual([]);
      const catalog = lib.readCatalog(copy);
      const original = structure.readSnapshot().counts;
      const tables = original["表"];
      const indexes = original["索引"];
      if (!tables || !indexes) throw new Error("结构快照缺少表或索引计数");
      const expected = {
        ...original,
        表: tables.map((value) => value + 1),
        索引: indexes.map((value) => value + 1),
      };
      expect(lib.countsOf(catalog)).toEqual(expected);
      expect(lib.countReport([["现行新表库", catalog]], expected).problems).toEqual([]);
      expect(lib.countReport([["现行新表库", catalog]]).problems).not.toEqual([]);
      mkdirSync(join(tree, "packages/db/snapshot"), { recursive: true });
      writeFileSync(
        join(tree, "packages/db/snapshot/structure.txt"),
        structure.renderSnapshot(structure.readStructure(copy)),
      );
      const checked = run(
        "node",
        [
          "infra/ci/db-catalog-diff.mjs",
          "--ref",
          copy,
          "--target",
          copy,
          "--report",
          join(temp.dir, "current-report.md"),
        ],
        tree,
      );
      expect(checked.status).toBe(0);
      expect(checked.output).toContain("首版冻结等价");
      expect(checked.output).toContain(
        `| 表 | ${expected["表"].join(" / ")} | ${expected["表"].join(" / ")} | ${expected["表"].join(" / ")} |`,
      );
    },
  );

  it("仅允许精确单条已确认索引假动作，旁加动作、重复、不同索引都拒绝", () => {
    const known = 'DROP INDEX "ix_store_asset_search";';
    expect(proof.schemaDiffProblems(`-- DropIndex\n${known}\n`)).toEqual([]);
    expect(proof.schemaDiffProblems("-- This is an empty migration.\n")).toEqual([]);
    for (const sql of [
      known + '\nALTER TABLE "biz_sequence" DROP COLUMN "next_val";',
      known + "\n" + known,
      'DROP INDEX "uq_staff_staff_no";',
    ])
      expect(proof.schemaDiffProblems(sql)).toHaveLength(1);
  });

  it("计数以当前传入的完整七项为准，仍查出污染，缺项不能伪通过", () => {
    const catalog = lib.readCatalog(base);
    const counts = lib.countsOf(catalog);
    expect(lib.countReport([["现行库", catalog]], counts).problems).toEqual([]);
    const tables = counts["表"];
    if (!tables) throw new Error("目录计数缺少表");
    expect(
      lib.countReport([["现行库", catalog]], { ...counts, 表: [tables[0] + 1, tables[1] + 1] })
        .problems,
    ).toHaveLength(1);
    const { 表: _tables, ...missing } = counts;
    expect(() => lib.countReport([["现行库", catalog]], missing)).toThrow("计数期望必须完整");
  });
});
