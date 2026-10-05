import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertTestDatabaseName,
  assertTestDatabaseUrl,
  connectTestDatabase,
  createTestDatabase,
  dropTestDatabase,
  renameTestDatabase,
  resetTestDatabase,
  resolveTestSession,
  resolveTestWorker,
  sessionOfTestDatabase,
  templateDatabaseName,
  TestDatabaseNameError,
  testDatabaseName,
  testDatabaseUrl,
} from "./database.js";

// 连库、连 Redis、起子进程的用例：实例忙的时候（别的会话同时在跑）会慢，时限放宽，不用缺省的 5 秒
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// 库名守卫（W0-05b 任务书 第 7 节第 4 条）：误连非 lyx_test_ 库即拒绝，且一句 SQL 都不发。
// “不发 SQL”的判法：盯住 pg 连接的 connect 与 query，被拒的名字走完四个入口后两者都没被调过；
// 最后拿一个合规的名字走一遍删库，确认同一副眼睛看得见真的 SQL。

// 任务书点名的四个，外加几种容易放过去的写法
const REJECTED: unknown[] = [
  "postgres",
  "liyoxi",
  "lyx_schema_check",
  "test_x",
  "lyx_migrate_check",
  "template1",
  "lyx_test_", // 只有前缀
  "LYX_TEST_X", // 大写
  "lyx_test_a-b", // 连字符
  'lyx_test_a"; DROP DATABASE liyoxi; --',
  "xlyx_test_a", // 前缀不在开头
  " lyx_test_a",
  `lyx_test_${"a".repeat(55)}`, // 64 个字符
  "",
  undefined,
  null,
  42,
];

/** 一个合规的名字：与被拒的名字搭配着用。万一守卫漏了，动到的也只是本 worker 自己的这个库 */
const OK = testDatabaseName("db", { label: "guardok" });

/** 四个入口，外加由它们派生的几个。每个都应当在守卫处抛错 */
const ENTRIES: Array<[string, (name: string) => unknown]> = [
  ["建库", (name) => createTestDatabase(name)],
  ["建库（名字合规、模板库不合规）", (name) => createTestDatabase(OK, { template: name })],
  ["删库", (name) => dropTestDatabase(name)],
  ["重置", (name) => resetTestDatabase(name)],
  ["重置（名字合规、模板库不合规）", (name) => resetTestDatabase(OK, { template: name })],
  ["连接", (name) => connectTestDatabase(name)],
  ["连接串", (name) => testDatabaseUrl(name)],
  ["改名（源）", (name) => renameTestDatabase(name, OK)],
  ["改名（目标）", (name) => renameTestDatabase(OK, name)],
];

afterEach(() => {
  vi.restoreAllMocks();
});

function watchSql() {
  return {
    connect: vi.spyOn(pg.Client.prototype, "connect"),
    query: vi.spyOn(pg.Client.prototype, "query"),
  };
}

describe("库名守卫", () => {
  it("只放行 lyx_test_ 开头、小写字母数字下划线、不超过 63 个字符的名字", () => {
    for (const name of ["lyx_test_a", "lyx_test_db_ab12cd34_3", `lyx_test_${"a".repeat(54)}`]) {
      expect(() => assertTestDatabaseName(name)).not.toThrow();
    }
    for (const name of REJECTED) {
      expect(() => assertTestDatabaseName(name)).toThrow(TestDatabaseNameError);
    }
  });

  it.each(ENTRIES)("%s：被拒的名字一律抛错，没有连接、没有 SQL", async (label, entry) => {
    const sql = watchSql();
    // 模板库不给（undefined、null）是“用本会话的模板库”，不是被拒的名字
    const names = label.includes("模板库") ? REJECTED.filter((name) => name != null) : REJECTED;
    for (const name of names) {
      // 同步抛与返回被拒的 Promise 都算；包一层 async 统一成 Promise
      await expect((async () => entry(name as string))()).rejects.toBeInstanceOf(
        TestDatabaseNameError,
      );
    }
    expect(sql.connect).not.toHaveBeenCalled();
    expect(sql.query).not.toHaveBeenCalled();
  });

  it("对照：合规的名字走删库，connect 与 query 都看得见", async () => {
    const sql = watchSql();
    await dropTestDatabase(OK);
    expect(sql.connect).toHaveBeenCalledTimes(1);
    expect(sql.query.mock.calls.map((call) => call[0])).toEqual([
      `DROP DATABASE IF EXISTS "${OK}" WITH (FORCE)`,
    ]);
  });

  it("连接串把关：库名不是测试库即抛错", () => {
    const base = "postgresql://someone:secret@localhost:5442";
    expect(() => assertTestDatabaseUrl(`${base}/lyx_test_db_ab12cd34_1`)).not.toThrow();
    for (const db of ["liyoxi", "postgres", "lyx_schema_check", "test_x", ""]) {
      expect(() => assertTestDatabaseUrl(`${base}/${db}`)).toThrow(TestDatabaseNameError);
    }
    expect(() => assertTestDatabaseUrl("不是连接串")).toThrow(TestDatabaseNameError);
    // 报错里不带连接串（里面有口令）
    try {
      assertTestDatabaseUrl(`${base}/liyoxi`);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});

describe("库名怎么拼", () => {
  it("lyx_test_<包>_<会话标识>_<worker 编号>[_<标签>]；模板库 lyx_test_tpl_<会话标识>", () => {
    const parts = { session: "ab12cd34", worker: "3" };
    expect(testDatabaseName("db", parts)).toBe("lyx_test_db_ab12cd34_3");
    expect(testDatabaseName("services", { ...parts, label: "b" })).toBe(
      "lyx_test_services_ab12cd34_3_b",
    );
    expect(templateDatabaseName("ab12cd34")).toBe("lyx_test_tpl_ab12cd34");
    // 最长的组合也在 63 个字符之内
    const longest = testDatabaseName("services", {
      session: "a".repeat(12),
      worker: "9999",
      label: "b".repeat(12),
    });
    expect(longest.length).toBeLessThanOrEqual(63);
  });

  it("包、会话标识、worker 编号、标签写错即抛错", () => {
    expect(() => testDatabaseName("infra" as "db")).toThrow(/包只能是/);
    expect(() => testDatabaseName("db", { session: "A_B" })).toThrow(/会话标识/);
    expect(() => testDatabaseName("db", { worker: "x" })).toThrow(/worker 编号/);
    expect(() => testDatabaseName("db", { label: "a_b" })).toThrow(/标签/);
  });

  it("会话标识取 LYX_TEST_SESSION；没设就取检出根路径的短哈希，同一个检出每次相同", () => {
    expect(resolveTestSession({ LYX_TEST_SESSION: "s1" })).toBe("s1");
    expect(resolveTestSession({ LYX_TEST_SESSION: "  s1 " })).toBe("s1");
    const hashed = resolveTestSession({});
    expect(hashed).toMatch(/^[0-9a-f]{8}$/);
    expect(resolveTestSession({ LYX_TEST_SESSION: "" })).toBe(hashed);
    expect(() => resolveTestSession({ LYX_TEST_SESSION: "有空格 的" })).toThrow(/LYX_TEST_SESSION/);
    expect(() => resolveTestSession({ LYX_TEST_SESSION: "a".repeat(13) })).toThrow();
  });

  it("worker 编号取 Vitest 给的 VITEST_POOL_ID；本进程里它是 1 到并行数之间的数字", () => {
    expect(resolveTestWorker({ VITEST_POOL_ID: "7" })).toBe("7");
    expect(resolveTestWorker({})).toBe("0");
    expect(() => resolveTestWorker({ VITEST_POOL_ID: "a" })).toThrow();
    expect(Number(resolveTestWorker())).toBeGreaterThanOrEqual(1);
  });

  it("从库名认出会话：只认本支架拼出来的形状", () => {
    expect(sessionOfTestDatabase("lyx_test_db_ab12cd34_3")).toBe("ab12cd34");
    expect(sessionOfTestDatabase("lyx_test_tpl_ab12cd34")).toBe("ab12cd34");
    expect(sessionOfTestDatabase("lyx_test_services_s1_2_b")).toBe("s1");
    // infra 用例自己建的库不按本支架的规矩命名
    expect(sessionOfTestDatabase("lyx_test_infra_catdiff_12345")).toBeUndefined();
    expect(sessionOfTestDatabase("lyx_migrate_check")).toBeUndefined();
  });
});
