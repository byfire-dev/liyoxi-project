// 带种子的干净库的连库用例（任务书 W0-25 第 7 节第 1、2 条）。
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { STAFF_ROLE_KEY } from "@liyoxi/contract";
import { describe, expect, it } from "vitest";

import { createTxRunner } from "../../kernel/index.js";
import { checkSeedAssertions, runSeed } from "../../seed.js";
import {
  connectTestDatabase,
  createClock,
  DEFAULT_CLOCK_START,
  derivedTemplateName,
  dropTestDatabase,
  ensureSeededTemplate,
  resetTestDatabase,
  SEEDED_TEMPLATE_LABEL,
  testDatabaseName,
  useSeededDatabase,
} from "../index.js";

const db = useSeededDatabase("services");
const second = useSeededDatabase("services", { label: "b" });
// 机器忙时拷库、删库、跑迁移都会慢：时限留足
const TIMEOUT = { timeout: 180_000 };
const clock = createClock();

describe("useSeededDatabase", () => {
  it("库里有种子：应用角色，六条断言 0 违规，再播一遍新增 0 行", TIMEOUT, async () => {
    const prisma = await db.prisma();
    const who = await prisma.$queryRawUnsafe<{ current_user: string }[]>("SELECT current_user");
    expect(who[0]?.current_user).toBe("lyx_app");

    const roles = await prisma.staffRole.findMany({ select: { key: true, createdAt: true } });
    expect(roles.map((role) => role.key).sort()).toEqual([...STAFF_ROLE_KEY.values].sort());
    // 播种的时刻是可拨时钟的缺省起点：用例的时钟不往回拨，种子就都已生效
    expect(new Set(roles.map((role) => role.createdAt.toISOString()))).toEqual(
      new Set([DEFAULT_CLOCK_START]),
    );
    expect(await prisma.agreement.count()).toBeGreaterThan(0);
    expect(await prisma.plan.count()).toBeGreaterThan(0);
    expect(await checkSeedAssertions(prisma, clock.now())).toEqual([]);

    const again = await runSeed({ tx: createTxRunner({ prisma, appEnv: "test" }), clock });
    expect(again.inserted).toBe(0);
  });

  it("种子只播一次：两个库都从同一个带种子的模板库拷", TIMEOUT, async () => {
    expect(await ensureSeededTemplate()).toBe(derivedTemplateName(SEEDED_TEMPLATE_LABEL));
    const [a, b] = await Promise.all([db.prisma(), second.prisma()]);
    const fingerprint = (prisma: typeof a) =>
      prisma.$queryRawUnsafe<{ digest: string }[]>(
        "SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest FROM dict_item t",
      );
    // 字典项的主键是播种时生成的 UUID：两个库逐行相同，只能是拷出来的
    expect(await fingerprint(a)).toEqual(await fingerprint(b));
  });

  it("重置：用例写的行没了，种子还在", TIMEOUT, async () => {
    const before = await second.prisma();
    await before.$executeRawUnsafe(
      "INSERT INTO biz_sequence (prefix, biz_date, next_val) VALUES ('LYX', DATE '2026-01-05', 2)",
    );
    expect(await before.bizSequence.count()).toBe(1);
    await second.reset();
    const after = await second.prisma();
    expect(await after.bizSequence.count()).toBe(0);
    expect(await after.staffRole.count()).toBe(STAFF_ROLE_KEY.values.length);
  });
});

describe("pnpm test:db:seeded", () => {
  it("一条命令：同名的库删掉重建，迁移与种子都在，打印库名", TIMEOUT, async () => {
    const name = testDatabaseName("services", { label: "cli" });
    // 先放一个“上一遍留下的”库：里面多一张表
    await resetTestDatabase(name);
    const stale = await connectTestDatabase(name, { role: null });
    await stale.query("CREATE TABLE lyx_w025_leftover (n int)");
    await stale.end();

    try {
      const tsx = createRequire(import.meta.url).resolve("tsx/cli");
      const run = spawnSync(process.execPath, [tsx, "scripts/seeded-db.ts", "--name", name], {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        encoding: "utf8",
        timeout: 150_000,
      });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain(`带种子的干净库：${name}`);
      expect(run.stdout).toMatch(/播种新增 [1-9]\d* 行；断言 0 条违规/);
      // 连接串与口令不打印
      expect(run.stdout + run.stderr).not.toContain(
        new URL(process.env.DATABASE_URL ?? "").password,
      );

      const fresh = await connectTestDatabase(name, { role: null });
      try {
        const rows = await fresh.query<{ leftover: string | null; roles: number; applied: number }>(
          `SELECT to_regclass('public.lyx_w025_leftover')::text AS leftover,
                  (SELECT count(*)::int FROM staff_role) AS roles,
                  (SELECT count(*)::int FROM _prisma_migrations WHERE finished_at IS NOT NULL) AS applied`,
        );
        expect(rows.rows[0]?.leftover).toBeNull();
        expect(rows.rows[0]?.roles).toBe(STAFF_ROLE_KEY.values.length);
        expect(rows.rows[0]?.applied).toBeGreaterThan(0);
      } finally {
        await fresh.end();
      }
    } finally {
      await dropTestDatabase(name);
    }
  });
});
