import { afterAll, describe, expect, it, vi } from "vitest";

import {
  connectTestDatabase,
  dropTestDatabase,
  resolveTestSession,
  templateDatabaseName,
  TestDatabaseNameError,
} from "./database.js";
import {
  createMigratedTestDatabase,
  derivedTemplateName,
  ensureDerivedTemplate,
} from "./derived.js";
import { useTestDatabase } from "./worker.js";

// 连库的用例：实例忙的时候会慢，时限放宽
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// 派生模板库（W0-25）：从模板库拷一份、加工一次、关掉连接入口，之后的测试库从它拷。
// 标签带 worker 编号：同一轮里别的 worker 不会碰到这一个。
const LABEL = `probe${process.env.VITEST_POOL_ID ?? "0"}`;
const session = resolveTestSession();
const derived = derivedTemplateName(LABEL);

let builds = 0;
/** 加工：建一张探针表，写一行。用属主身份（应用角色建不了表） */
async function build(name: string): Promise<void> {
  builds += 1;
  const client = await connectTestDatabase(name, { role: null });
  try {
    await client.query("create table lyx_derived_probe (n int not null)");
    await client.query("insert into lyx_derived_probe values (1)");
  } finally {
    await client.end();
  }
}

const own = useTestDatabase("db", {
  label: "derived",
  role: null,
  template: () => ensureDerivedTemplate(LABEL, build),
});

afterAll(async () => {
  await dropTestDatabase(derived);
});

describe("派生模板库", () => {
  it("名字是“模板库名_标签”，过库名守卫；标签写错即抛错", () => {
    expect(derived).toBe(`${templateDatabaseName(session)}_${LABEL}`);
    expect(() => derivedTemplateName("Seed")).toThrow(/标签/);
    expect(() => derivedTemplateName("a_b")).toThrow(/标签/);
  });

  it("两处同时要：只加工一次，拿到同一个库；库的连接入口已关", async () => {
    const names = await Promise.all([
      ensureDerivedTemplate(LABEL, build),
      ensureDerivedTemplate(LABEL, build),
    ]);
    expect(names).toEqual([derived, derived]);
    expect(builds).toBe(1);

    // 借自己的库看一眼系统目录（pg_database 是全实例共用的）
    await own.url();
    const client = await connectTestDatabase(own.name, { role: null });
    try {
      const rows = await client.query<{ datallowconn: boolean; marker: string | null }>(
        "select datallowconn, shobj_description(oid, 'pg_database') as marker from pg_database where datname = $1",
        [derived],
      );
      expect(rows.rows[0]?.datallowconn).toBe(false);
      expect(rows.rows[0]?.marker).toMatch(/^lyx-derived-from:\d+$/);
    } finally {
      await client.end();
    }
  });

  it("再要一次：已经加工好的直接用，不重做", async () => {
    expect(await ensureDerivedTemplate(LABEL, build)).toBe(derived);
    expect(builds).toBe(1);
  });

  it("测试库从它拷：加工时写的行在；重置之后仍是加工完的样子", async () => {
    const read = async () => {
      const prisma = await own.prisma();
      return prisma.$queryRawUnsafe<{ n: number }[]>("select n from lyx_derived_probe order by n");
    };
    expect(await read()).toEqual([{ n: 1 }]);
    await (await own.prisma()).$executeRawUnsafe("insert into lyx_derived_probe values (2)");
    expect(await read()).toEqual([{ n: 1 }, { n: 2 }]);
    await own.reset();
    expect(await read()).toEqual([{ n: 1 }]);
    expect(builds).toBe(1);
  });
});

describe("不靠模板的迁移库", () => {
  it("只动测试库：名字不是 lyx_test_ 开头、或是模板库的名字，一句 SQL 都不发", async () => {
    await expect(createMigratedTestDatabase("liyoxi")).rejects.toBeInstanceOf(
      TestDatabaseNameError,
    );
    await expect(createMigratedTestDatabase("lyx_migrate_check")).rejects.toBeInstanceOf(
      TestDatabaseNameError,
    );
    await expect(createMigratedTestDatabase(templateDatabaseName(session))).rejects.toThrow(
      /模板库的名字/,
    );
    await expect(createMigratedTestDatabase(derived)).rejects.toThrow(/模板库的名字/);
  });
});
