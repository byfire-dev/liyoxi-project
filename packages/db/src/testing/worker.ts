// 按 worker 建库（W0-05b）：每个 Vitest worker 一个库，从本会话的模板库拷。
//
// 用法：测试文件顶层写一行
//   const db = useTestDatabase("services");
// 用例里 `const prisma = await db.prisma()`。首次取连接时才建库；文件跑完，用例全过就删库，
// 有用例失败就把库改名留下并打印库名（看完用 pnpm test:db:prune 清掉）。
// 改名是因为同一个 worker 编号马上会被下一个测试文件用到，不改名留不住。

import { afterAll, beforeEach } from "vitest";

import { createPrismaClient } from "../index.js";
import type { PrismaClient } from "../index.js";
import {
  dropTestDatabase,
  renameTestDatabase,
  resetTestDatabase,
  testDatabaseName,
  testDatabaseUrl,
} from "./database.js";
import type { TestConnectionOptions, TestPackage } from "./database.js";

/**
 * 收尾钩子的时限。删库平时不到一秒，但它要等数据库做一次检查点：
 * 同一个实例上别的会话正在大批建表时会慢到十几秒，Vitest 缺省的 10 秒不够。
 */
const DISPOSE_TIMEOUT_MS = 120_000;

export interface TestDatabaseOptions extends TestConnectionOptions {
  /** 同一个测试文件要第二个库时给个标签，如 "b" */
  label?: string;
  /** Prisma 客户端的连接数上限，缺省 4 */
  max?: number;
}

export interface TestDatabase {
  /** 库名：lyx_test_<包>_<会话标识>_<worker 编号>[_<标签>] */
  readonly name: string;
  /** 连接串。首次调用时建库 */
  url(): Promise<string>;
  /** 本库的 Prisma 客户端，一个库一个实例。首次调用时建库；重置之后要重新取 */
  prisma(): Promise<PrismaClient>;
  /** 重置 = 删库重建（从模板库拷）。先前取的客户端作废 */
  reset(): Promise<void>;
}

/** 一个测试库从建到收尾。useTestDatabase 把它挂到 Vitest 的钩子上；单独用时自己调 dispose */
export class TestDatabaseHandle implements TestDatabase {
  readonly name: string;
  readonly #options: TestDatabaseOptions;
  #created: Promise<void> | undefined;
  #prisma: PrismaClient | undefined;

  constructor(name: string, options: TestDatabaseOptions = {}) {
    // 名字与角色在这里就过一遍守卫：不是测试库、角色名写错，构造时即抛错
    testDatabaseUrl(name, options);
    this.name = name;
    this.#options = options;
  }

  /** 库建了没有 */
  get created(): boolean {
    return this.#created !== undefined;
  }

  #ensure(): Promise<void> {
    // 同名的库还在，说明上一轮没收尾（进程被杀）：删掉重建
    this.#created ??= resetTestDatabase(this.name);
    return this.#created;
  }

  async url(): Promise<string> {
    await this.#ensure();
    return testDatabaseUrl(this.name, this.#options);
  }

  async prisma(): Promise<PrismaClient> {
    const connectionString = await this.url();
    this.#prisma ??= createPrismaClient({ connectionString, max: this.#options.max ?? 4 });
    return this.#prisma;
  }

  async #disconnect(): Promise<void> {
    const prisma = this.#prisma;
    this.#prisma = undefined;
    await prisma?.$disconnect();
  }

  async reset(): Promise<void> {
    await this.#disconnect();
    this.#created = resetTestDatabase(this.name);
    await this.#created;
  }

  /**
   * 收尾。没建过库就什么都不做；用例全过即删库；有失败就改名留下，返回留下的库名。
   * 改名不成（极少见）就原名留着，同样返回库名。
   */
  async dispose(outcome: { failed: boolean }): Promise<string | undefined> {
    await this.#disconnect();
    if (!this.#created) return undefined;
    await this.#created.catch(() => {});
    this.#created = undefined;
    if (!outcome.failed) {
      await dropTestDatabase(this.name);
      return undefined;
    }
    let kept = `${this.name}_k${Date.now().toString(36)}`;
    try {
      await renameTestDatabase(this.name, kept);
    } catch {
      kept = this.name;
    }
    console.warn(`有用例失败，测试库留着没删：${kept}（看完用 pnpm test:db:prune 清掉）`);
    return kept;
  }
}

/**
 * 给当前测试文件一个库。在文件顶层（或 describe 里）调用：它登记两个钩子，
 * 一个记下有没有用例失败，一个在这一组用例跑完后收尾。
 * @param pkg 库名里的包：db、services、api、worker
 */
export function useTestDatabase(pkg: TestPackage, options: TestDatabaseOptions = {}): TestDatabase {
  const handle = new TestDatabaseHandle(testDatabaseName(pkg, { label: options.label }), options);
  let failed = false;
  beforeEach(({ onTestFailed }) => {
    onTestFailed(() => {
      failed = true;
    });
  });
  afterAll(async () => {
    await handle.dispose({ failed });
  }, DISPOSE_TIMEOUT_MS);
  return handle;
}
