// 派生模板库，与不靠模板的迁移库（W0-25）。
//
// 派生模板库：从本会话的模板库（只跑了迁移）拷一份，交给调用方加工（如播种），加工完关掉连接入口；
// 之后建测试库时拿它当模板。加工在一轮测试里只做一次，每个测试文件的库照旧只付一次拷库。
//   名字：lyx_test_tpl_<会话标识>_<标签>，如带种子的那一个是 lyx_test_tpl_<会话标识>_seed。
//   并发：几个 worker 进程同时要，靠维护库上的一把咨询锁排队，后到的看到的是先到的已经做完的库。
//   新旧：加工完在库的注释里记下所拷模板库的 oid。模板库每轮测试都重建，oid 随之变，
//         上一轮留下的派生库（进程被杀、没收尾）对不上，作废重做。注释最后写：做到一半失败的也对不上。
//   收尾：一轮结束时由 globalSetup 连同模板库一起删（global-setup.ts 的 release）。
// 不靠模板的迁移库：不在一轮测试里（没有模板库）也要一个跑完迁移的测试库时用，如命令行 pnpm test:db:seeded。
//
// 两个入口都先过库名守卫，只动 lyx_test_ 开头的库。管理连接连维护库 postgres，账号取 DATABASE_URL。

import pg from "pg";

import {
  assertTestDatabaseName,
  recordTestUsage,
  resolveTestSession,
  templateDatabaseName,
  TEST_DATABASE_PREFIX,
  testDatabaseUrl,
} from "./database.js";
import { migrateDeploy } from "./global-setup.js";

const LABEL = /^[a-z0-9]{1,12}$/;

/** 派生模板库名：lyx_test_tpl_<会话标识>_<标签> */
export function derivedTemplateName(label: string, session: string = resolveTestSession()): string {
  if (!LABEL.test(label)) throw new Error("派生模板库的标签只接受 1–12 位小写字母与数字");
  const name = `${templateDatabaseName(session)}_${label}`;
  assertTestDatabaseName(name);
  return name;
}

async function withAdmin<T>(run: (admin: pg.Client) => Promise<T>): Promise<T> {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "DATABASE_URL 未设置：测试支架用它的主机与账号连本地的 PostgreSQL（取值见 CLAUDE.md 第 9 节）",
    );
  }
  const url = new URL(base);
  url.pathname = "/postgres";
  url.search = "";
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    return await run(admin);
  } finally {
    // 连接一断，下面占的咨询锁自动释放
    await admin.end();
  }
}

const sqlState = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

/**
 * 要一个派生模板库：本轮已经加工好的直接用，没有就从模板库拷一份、调 build 加工、关掉连接入口。
 * @param label 标签，进库名
 * @param build 加工：拿到库名，自己连上去写（连接用完要断开）。抛错即这次不算数，下次重做
 * @returns 派生模板库名，交给 useTestDatabase 的 template 选项或 resetTestDatabase
 */
export async function ensureDerivedTemplate(
  label: string,
  build: (name: string) => Promise<void>,
): Promise<string> {
  const template = templateDatabaseName();
  const name = derivedTemplateName(label);
  await withAdmin(async (admin) => {
    await admin.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      `lyx_test_derived:${name}`,
    ]);
    const base = await admin.query<{ oid: string }>(
      "select oid::text as oid from pg_database where datname = $1",
      [template],
    );
    const baseOid = base.rows[0]?.oid;
    if (baseOid === undefined) {
      throw new Error(
        `模板库 ${template} 不存在：本包的 vitest.config.ts 要挂 globalSetup（@liyoxi/services/testing/global-setup），由它在每轮测试开始时建模板库`,
      );
    }
    const marker = `lyx-derived-from:${baseOid}`;
    const existing = await admin.query<{ marker: string | null }>(
      "select shobj_description(oid, 'pg_database') as marker from pg_database where datname = $1",
      [name],
    );
    if (existing.rows[0]?.marker === marker) return;

    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    // 模板库上有别的连接时建不了（55006）：别的 worker 正从它拷库的那一瞬间会碰上，等一下再试
    for (let attempt = 1; ; attempt += 1) {
      try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
        break;
      } catch (error) {
        if (sqlState(error) !== "55006" || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
    recordTestUsage("database", name);
    await build(name);
    // 之后要拿它当模板，库上不能留着连接：加工时没断干净的在这里断掉
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [name],
    );
    await admin.query(`ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS false`);
    await admin.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
  });
  return name;
}

/**
 * 建一个跑完全部迁移的测试库，不靠模板库：不在一轮测试里也能用。已存在即删掉重建。
 * 库里只有迁移，没有种子；跑迁移用 DATABASE_URL 的账号（它成了表的属主）。
 */
export async function createMigratedTestDatabase(name: string): Promise<void> {
  assertTestDatabaseName(name);
  if (name.startsWith(`${TEST_DATABASE_PREFIX}tpl_`)) {
    throw new Error(`${name} 是模板库的名字，留给 globalSetup 用`);
  }
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  });
  await migrateDeploy(testDatabaseUrl(name, { role: null }));
  recordTestUsage("database", name);
}
