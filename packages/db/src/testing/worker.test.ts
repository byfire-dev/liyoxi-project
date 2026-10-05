import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runNestedVitest } from "./__fixtures__/nested.js";
import {
  connectTestDatabase,
  createTestDatabase,
  dropTestDatabase,
  listTestDatabases,
  resolveTestSession,
  resolveTestWorker,
  testDatabaseName,
} from "./database.js";
import { TestDatabaseHandle, useTestDatabase } from "./worker.js";

// 连库、连 Redis、起子进程的用例：实例忙的时候（别的会话同时在跑）会慢，时限放宽，不用缺省的 5 秒
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// 按 worker 建库（W0-05b 任务书 第 10 节第 3 项）：worker 编号取 Vitest 给的环境变量；首次取连接时建库；
// 用例全过即删库，有失败就留库并打印库名。

const session = resolveTestSession();
const exists = async (name: string) => (await listTestDatabases({ session })).includes(name);
const own = useTestDatabase("db");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useTestDatabase", () => {
  it("库名带本会话与本 worker 的编号；首次取连接时才建库", { timeout: 120_000 }, async () => {
    expect(own.name).toBe(`lyx_test_db_${session}_${resolveTestWorker()}`);
    expect(own.name).toBe(`lyx_test_db_${session}_${process.env.VITEST_POOL_ID}`);
    expect(await exists(own.name)).toBe(false);
    const prisma = await own.prisma();
    expect(await exists(own.name)).toBe(true);
    const rows = await prisma.$queryRaw<
      Array<{ db: string }>
    >`select current_database()::text as db`;
    expect(rows).toEqual([{ db: own.name }]);
    // 一个库一个客户端实例
    expect(await own.prisma()).toBe(prisma);
  });

  it("嵌套跑一轮：全过的文件删库，有失败的文件留库并打印库名", { timeout: 120_000 }, async () => {
    const result = runNestedVitest("hooks-", { maxWorkers: 2 });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(/Test Files\s+1 failed \| 1 passed \(2\)/);
    const kept = new RegExp(
      `有用例或钩子失败，测试库留着没删：(lyx_test_db_${session}_\\d+_hookfail_k[a-z0-9]+)`,
    ).exec(result.output)?.[1];
    expect(kept, result.output).toBeDefined();
    if (!kept) return;
    try {
      const left = (await listTestDatabases({ session })).filter((name) => name.includes("_hook"));
      expect(left).toEqual([kept]);
      // 留下的库里，失败之前写的数据还在
      const client = await connectTestDatabase(kept);
      try {
        expect((await client.query("select outcome from lyx_hooks_probe")).rows).toEqual([
          { outcome: "fail" },
        ]);
      } finally {
        await client.end();
      }
    } finally {
      await dropTestDatabase(kept);
    }
  });
});

describe("useTestDatabase：钩子里失败也算失败", () => {
  it(
    "嵌套跑一轮：beforeAll 失败、别的 afterAll 失败、里层 describe 的 beforeAll 失败，库都留着",
    { timeout: 120_000 },
    async () => {
      const result = runNestedVitest("suite-", { maxWorkers: 3 });
      expect(result.status, result.output).toBe(1);
      expect(result.output).toMatch(/Test Files\s+3 failed \(3\)/);
      const kept = [
        ...result.output.matchAll(
          new RegExp(`测试库留着没删：(lyx_test_db_${session}_\\d+_(s[a-z]+)_k[a-z0-9]+)`, "g"),
        ),
      ].map((match) => ({ name: match[1] ?? "", label: match[2] ?? "" }));
      try {
        expect(kept.map((entry) => entry.label).sort(), result.output).toEqual([
          "safter",
          "sbefore",
          "snested",
        ]);
        // 原名都腾出来了，留下的只有改了名的三个
        const left = (await listTestDatabases({ session })).filter((name) =>
          /_s(before|after|nested)(_|$)/.test(name),
        );
        expect(left.sort()).toEqual(kept.map((entry) => entry.name).sort());
        // 留下的库里，失败之前写的数据还在
        const outcomes: string[] = [];
        for (const { name } of kept) {
          const client = await connectTestDatabase(name);
          try {
            const rows = (
              await client.query<{ outcome: string }>("select outcome from lyx_hooks_probe")
            ).rows;
            outcomes.push(...rows.map((row) => row.outcome));
          } finally {
            await client.end();
          }
        }
        expect(outcomes.sort()).toEqual(["after-all", "before-all", "nested"]);
      } finally {
        const leftovers = (await listTestDatabases({ session })).filter((name) =>
          /_s(before|after|nested)(_|$)/.test(name),
        );
        for (const name of leftovers) await dropTestDatabase(name);
      }
    },
  );
});

describe("TestDatabaseHandle", () => {
  it("没取过连接的收尾什么都不做，库没建过", async () => {
    const handle = new TestDatabaseHandle(testDatabaseName("db", { label: "never" }));
    expect(handle.created).toBe(false);
    expect(await handle.dispose({ failed: true })).toBeUndefined();
    expect(await exists(handle.name)).toBe(false);
  });

  it("有用例失败：库改名留下并打印库名；原名腾出来", { timeout: 120_000 }, async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = new TestDatabaseHandle(testDatabaseName("db", { label: "bad" }));
    const prisma = await handle.prisma();
    await prisma.$executeRawUnsafe("create table lyx_keep_probe as select 1 as n");
    const kept = await handle.dispose({ failed: true });
    try {
      expect(kept).toMatch(new RegExp(`^${handle.name}_k[a-z0-9]+$`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`测试库留着没删：${kept}`));
      expect(await exists(handle.name)).toBe(false);
      const client = await connectTestDatabase(kept ?? "");
      try {
        expect((await client.query("select n from lyx_keep_probe")).rows).toEqual([{ n: 1 }]);
      } finally {
        await client.end();
      }
    } finally {
      if (kept) await dropTestDatabase(kept);
    }
  });

  it(
    "上一轮没收尾留下的同名库：删掉重建，不带旧数据；用例全过，收尾即删库",
    { timeout: 120_000 },
    async () => {
      const name = testDatabaseName("db", { label: "stale" });
      await dropTestDatabase(name);
      await createTestDatabase(name);
      const before = await connectTestDatabase(name);
      await before.query("create table lyx_stale_probe as select 1 as n");
      await before.end();

      const handle = new TestDatabaseHandle(name);
      const prisma = await handle.prisma();
      const rows = await prisma.$queryRaw<Array<{ found: boolean }>>`
      select to_regclass('public.lyx_stale_probe') is not null as found`;
      expect(rows).toEqual([{ found: false }]);
      expect(await exists(name)).toBe(true);
      expect(await handle.dispose({ failed: false })).toBeUndefined();
      expect(await exists(name)).toBe(false);
    },
  );

  it("role 选项：连上之后切到指定的角色；缺省不切", { timeout: 120_000 }, async () => {
    interface Who {
      current: string;
      session: string;
    }
    const who = "select current_user::text as current, session_user::text as session";
    const [byDefault] = await (await own.prisma()).$queryRawUnsafe<Who[]>(who);
    expect(byDefault?.current).toBe(byDefault?.session);

    // pg_read_all_data 是 PostgreSQL 自带的只读角色：切过去之后能读、不能写。应用角色 lyx_app 由 W0-06a 建
    const handle = new TestDatabaseHandle(testDatabaseName("db", { label: "role" }), {
      role: "pg_read_all_data",
    });
    try {
      const prisma = await handle.prisma();
      expect(await prisma.$queryRawUnsafe<Who[]>(who)).toEqual([
        { current: "pg_read_all_data", session: byDefault?.session },
      ]);
      expect(await prisma.authEvent.count()).toBe(0);
      await expect(
        prisma.authEvent.create({
          data: { id: randomUUID(), createdAt: new Date(), space: "staff", event: "logout" },
        }),
      ).rejects.toThrow(/permission denied for table auth_event/);
    } finally {
      await handle.dispose({ failed: false });
    }
    // 角色名写错：构造时就抛错，不建库
    expect(() => new TestDatabaseHandle(handle.name, { role: "x; drop role y" })).toThrow(/角色名/);
    expect(await exists(handle.name)).toBe(false);
  });

  it("名字不是测试库：构造时就被守卫拒掉", () => {
    for (const name of ["postgres", "liyoxi", "lyx_schema_check", "test_x"]) {
      expect(() => new TestDatabaseHandle(name)).toThrow(/只动 lyx_test_ 开头的库/);
    }
  });
});
