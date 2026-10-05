import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  dropTestDatabase,
  planPrune,
  pruneTestDatabases,
  resolveTestSession,
  resolveTestWorker,
  runningTestSessions,
  templateDatabaseName,
  TEST_SESSION_LOCK_SQL,
  testSessionLockKey,
} from "./database.js";
import { useTestDatabase } from "./worker.js";

// 连库、连 Redis、起子进程的用例：实例忙的时候（别的会话同时在跑）会慢，时限放宽，不用缺省的 5 秒
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// 清理命令（W0-05b 任务书 第 7 节第 9 条）：pnpm test:db:prune 只删 lyx_test_ 开头的库，别的库一个不动。
// 用例造两个假的会话标识（带本 worker 的编号与随机尾巴，撞不上别人），给它们各建几个库，
// 再建一个不带测试前缀的库当对照，然后跑真的命令。这几个库只看名字、不看内容，用管理连接直接建空库。

const PRUNE = fileURLToPath(new URL("./prune.mjs", import.meta.url));
const tail = randomBytes(3).toString("hex");
const mine = `p${resolveTestWorker()}x${tail}`;
const other = `p${resolveTestWorker()}y${tail}`;
const MINE = [`lyx_test_db_${mine}_1`, `lyx_test_services_${mine}_2_b`, `lyx_test_tpl_${mine}`];
const OTHER = `lyx_test_db_${other}_1`;
/** 不带测试前缀的对照库：支架不肯碰它，只能用管理连接直接建、直接删 */
const DECOY = `lyx_prunecheck_${mine}`;

const own = useTestDatabase("db");

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = "/postgres";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

const existing = (names: string[]) =>
  admin(async (client) => {
    const result = await client.query<{ datname: string }>(
      "select datname from pg_database where datname = any($1) order by datname",
      [names],
    );
    return result.rows.map((row) => row.datname);
  });

const prune = (...args: string[]) => {
  const result = spawnSync(process.execPath, [PRUNE, ...args], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
};

afterAll(async () => {
  for (const name of [...MINE, OTHER]) await dropTestDatabase(name);
  await admin((client) => client.query(`DROP DATABASE IF EXISTS "${DECOY}"`));
});

describe("pnpm test:db:prune", () => {
  it(
    "只删指定会话的 lyx_test_ 库；别的会话的、不带测试前缀的都不动",
    { timeout: 120_000 },
    async () => {
      await admin(async (client) => {
        for (const name of [...MINE, OTHER, DECOY]) await client.query(`CREATE DATABASE "${name}"`);
      });
      await own.url();
      const bystanders = [OTHER, DECOY, own.name, templateDatabaseName(), "postgres"].sort();
      expect(await existing([...MINE, ...bystanders])).toEqual([...MINE, ...bystanders].sort());

      // 先看不动手的：列出要删的三个，库都还在
      const dry = prune("--session", mine, "--dry-run");
      expect(dry.status, dry.output).toBe(0);
      expect(dry.output).toContain(`test:db:prune（会话 ${mine}）：要删 3 个，没删 0 个`);
      expect(await existing(MINE)).toEqual([...MINE].sort());

      const done = prune("--session", mine);
      expect(done.status, done.output).toBe(0);
      expect(done.output).toContain(`test:db:prune（会话 ${mine}）：已删 3 个，没删 0 个`);
      for (const name of MINE) expect(done.output).toContain(`已删 ${name}`);
      expect(done.output).not.toContain(OTHER);
      expect(done.output).not.toContain(DECOY);

      expect(await existing(MINE)).toEqual([]);
      expect(await existing(bystanders)).toEqual(bystanders);
    },
  );

  it("会话正有一轮测试在跑：它的库不删，列在没删里", { timeout: 120_000 }, async () => {
    // 本会话就是正在跑的这一轮：会话锁由 globalSetup 占着
    const session = resolveTestSession();
    await own.url();
    const plan = await pruneTestDatabases({ session });
    expect(plan.drop).toEqual([]);
    const skipped = plan.skipped.map((entry) => entry.name);
    expect(skipped).toContain(own.name);
    expect(skipped).toContain(templateDatabaseName());
    for (const entry of plan.skipped) expect(entry.reason).toBe(`会话 ${session} 正有一轮测试在跑`);
    expect(await existing([own.name, templateDatabaseName()])).toHaveLength(2);
  });

  it("用法写错：退出码 2，什么都不删", () => {
    for (const args of [["--bogus"], ["--session"], ["--session", "Not_A_Session"]]) {
      const result = prune(...args);
      expect(result.status, result.output).toBe(2);
      expect(result.output).toContain("test:db:prune：");
    }
  });
});

describe("runningTestSessions：只看会话锁，不去抢", () => {
  const lock = (client: pg.Client, session: string) =>
    client
      .query<{ locked: boolean }>(`select ${TEST_SESSION_LOCK_SQL} as locked`, [
        testSessionLockKey(session),
      ])
      .then((result) => result.rows[0]?.locked);

  it("锁被占着的会话算在跑，放掉之后不算；别的会话不受牵连", async () => {
    await admin(async (holder) => {
      expect(await lock(holder, mine)).toBe(true);
      expect([...(await runningTestSessions([mine, other, mine]))]).toEqual([mine]);
      await holder.query("select pg_advisory_unlock_all()");
      expect([...(await runningTestSessions([mine, other]))]).toEqual([]);
    });
    expect([...(await runningTestSessions([]))]).toEqual([]);
  });

  it("查的当口另一轮测试启动：它照样抢得到锁（查的人不加锁、不放锁）", async () => {
    await admin(async (starter) => {
      const original = pg.Client.prototype.query as (...all: unknown[]) => Promise<unknown>;
      const statements: string[] = [];
      const attempts: Array<boolean | undefined> = [];
      // 查的人每发一句 SQL 之前，“另一轮测试”先抢一次锁、抢到就放：查的人要是正占着锁，这一次就抢不到
      const query = vi.spyOn(pg.Client.prototype, "query").mockImplementation(async function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        if (this !== starter) {
          const first = args[0];
          statements.push(
            typeof first === "string" ? first : String((first as { text?: unknown }).text),
          );
          const result = (await original.call(
            starter,
            `select ${TEST_SESSION_LOCK_SQL} as locked`,
            [testSessionLockKey(other)],
          )) as { rows: Array<{ locked: boolean }> };
          attempts.push(result.rows[0]?.locked);
          await original.call(starter, "select pg_advisory_unlock_all()");
        }
        return original.apply(this, args);
      } as never);
      try {
        expect([...(await runningTestSessions([other]))]).toEqual([]);
      } finally {
        query.mockRestore();
      }
      expect(attempts).toEqual([true]);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("pg_locks");
      expect(statements.join("\n")).not.toMatch(/advisory_(xact_)?lock|advisory_unlock/);
    });
  });
});

describe("planPrune：从库名清单里挑要删的", () => {
  const names = [
    "postgres",
    "liyoxi",
    "lyx_schema_check",
    "lyx_migrate_check",
    "lyx_selftest_catdiff_1",
    "test_x",
    "lyx_test_db_aaaa_1",
    "lyx_test_db_aaaa_2_k1abc",
    "lyx_test_tpl_aaaa",
    "lyx_test_services_bbbb_1",
    "lyx_test_infra_catdiff_4242",
  ];

  it("按会话：只挑这个会话的", () => {
    expect(planPrune(names, { session: "aaaa" }, new Set())).toEqual({
      drop: ["lyx_test_db_aaaa_1", "lyx_test_db_aaaa_2_k1abc", "lyx_test_tpl_aaaa"],
      skipped: [],
    });
    expect(planPrune(names, { session: "cccc" }, new Set()).drop).toEqual([]);
  });

  it("全部：只挑 lyx_test_ 开头的，不按本支架命名的也在内；正在跑的会话跳过", () => {
    const plan = planPrune(names, { all: true }, new Set(["bbbb"]));
    expect(plan.drop).toEqual([
      "lyx_test_db_aaaa_1",
      "lyx_test_db_aaaa_2_k1abc",
      "lyx_test_tpl_aaaa",
      "lyx_test_infra_catdiff_4242",
    ]);
    expect(plan.skipped).toEqual([
      { name: "lyx_test_services_bbbb_1", reason: "会话 bbbb 正有一轮测试在跑" },
    ]);
  });

  it("不带测试前缀的名字，哪种范围都挑不出来", () => {
    const others = names.filter((name) => !name.startsWith("lyx_test_"));
    expect(planPrune(others, { all: true }, new Set())).toEqual({ drop: [], skipped: [] });
  });
});
