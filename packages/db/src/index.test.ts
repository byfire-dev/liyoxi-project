import { readdirSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "./index.js";

// 客户端工厂的用例（W0-05 任务书 第 7 节第 7 条）。连的是迁移库 lyx_migrate_check，只读不写。
// 主机与账号取环境变量 DATABASE_URL（本地的写法见 CLAUDE.md 第 9 节），库名换成迁移库。
// 连不上、或迁移库没建：整个文件失败，不跳过。先 pnpm infra:up，再照本包 README.md 的“本地准备”建迁移库。

const MIGRATE_DB = "lyx_migrate_check";

function migrateDbUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "DATABASE_URL 未设置：本包的用例要连本地的 PostgreSQL（取值见 CLAUDE.md 第 9 节，准备步骤见 packages/db/README.md）",
    );
  }
  const url = new URL(base);
  url.pathname = `/${MIGRATE_DB}`;
  return url.toString();
}

// api 主池的三个超时（D7 第 8.3 节）：这里只用来验证工厂把它们下发到了会话上
const TIMEOUTS = {
  statementTimeoutMs: 8_000,
  lockTimeoutMs: 3_000,
  idleInTransactionSessionTimeoutMs: 15_000,
};
const SETTINGS_SQL = `select current_setting('statement_timeout') as statement,
  current_setting('lock_timeout') as lock,
  current_setting('idle_in_transaction_session_timeout') as idle`;
type Settings = Array<{ statement: string; lock: string; idle: string }>;

const connectionString = migrateDbUrl();
const prisma = createPrismaClient({ connectionString, max: 2, ...TIMEOUTS });

beforeAll(async () => {
  try {
    await prisma.$queryRaw`select 1 from _prisma_migrations limit 1`;
  } catch (error) {
    throw new Error(
      `迁移库 ${MIGRATE_DB} 连不上，或还没跑过迁移。先 pnpm infra:up，再照 packages/db/README.md 的“本地准备”建库并跑 pnpm db:deploy。原始报错：${String(error)}`,
      { cause: error },
    );
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("createPrismaClient", () => {
  it("读一张表成功：普通表与按月分区的表", async () => {
    expect(Array.isArray(await prisma.idempotencyRecord.findMany({ take: 1 }))).toBe(true);
    expect(typeof (await prisma.analyticsEvent.count())).toBe("number");
  });

  it("交互式事务里 $queryRaw 可用；迁移库上每个迁移恰一行且已完成", async () => {
    const rows = await prisma.$transaction(
      (tx) =>
        tx.$queryRaw<Array<{ name: string; done: boolean }>>`
          select migration_name as name, finished_at is not null and rolled_back_at is null as done
            from _prisma_migrations order by migration_name`,
    );
    // 任务书 第 7 节第 3 条：现在只有首版迁移一个目录，即“恰一行且已完成”；以后加了迁移，这里跟着目录走
    const migrations = readdirSync(new URL("../prisma/migrations", import.meta.url), {
      withFileTypes: true,
    }).flatMap((entry) => (entry.isDirectory() ? [entry.name] : []));
    expect(rows).toEqual(migrations.sort().map((name) => ({ name, done: true })));
  });

  it("三个会话超时下发到了连接上，事务内外都生效", async () => {
    const expected = [{ statement: "8s", lock: "3s", idle: "15s" }];
    expect(await prisma.$queryRawUnsafe<Settings>(SETTINGS_SQL)).toEqual(expected);
    expect(await prisma.$transaction((tx) => tx.$queryRawUnsafe<Settings>(SETTINGS_SQL))).toEqual(
      expected,
    );
  });

  it("不给超时：沿用服务器的设置；连接数上限为 1 时所有查询走同一条连接", async () => {
    const single = createPrismaClient({ connectionString, max: 1 });
    try {
      const server = await single.$queryRawUnsafe<Settings>(SETTINGS_SQL);
      expect(server).toEqual([{ statement: "0", lock: "0", idle: "0" }]);
      const pids = await Promise.all(
        Array.from(
          { length: 5 },
          () => single.$queryRaw<Array<{ pid: number }>>`select pg_backend_pid() as pid`,
        ),
      );
      expect(new Set(pids.map((rows) => rows[0]?.pid)).size).toBe(1);
    } finally {
      await single.$disconnect();
    }
  });
});
