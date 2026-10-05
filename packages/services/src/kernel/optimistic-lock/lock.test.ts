import { COMMON_ERRORS } from "@liyoxi/contract/errors";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectTestDatabase, createClock, useTestDatabase } from "../../testing/index.js";
import { barrier, openClient } from "../__fixtures__/db.js";
import { uuidv7 } from "../ids.js";
import { createTxRunner } from "../tx.js";
import type { TxRunner } from "../tx.js";
import { bumpLockVersion, lockVersionField } from "./lock-version.js";

// 验收第 9 条：版本一致时更新成功且版本加 1；不一致 409 VERSION_CONFLICT，details 带最新值；
// 两条连接用同一版本并发更新只成功一个（甲类的并发测试，20 轮）；列名可指定。
// 用的表：point_pack（带 lock_version，没有外键；任务书 第 11 节第 5 项）。列名、主键列的例外用测试库里现建的探针表。

const ROUNDS = 20;
const SLOW = 120_000;

const db = useTestDatabase("services");
const clock = createClock();
let prisma: PrismaClient;
let left: PrismaClient;
let right: PrismaClient;
let tx: TxRunner;

beforeAll(async () => {
  prisma = await db.prisma();
  const owner = await connectTestDatabase(db.name, { role: null });
  try {
    await owner.query(`
      CREATE TABLE lyx_probe_lock (
        code text PRIMARY KEY,
        body text NOT NULL DEFAULT '',
        lock_version integer NOT NULL DEFAULT 0,
        draft_lock_version integer NOT NULL DEFAULT 0
      );
      GRANT SELECT, INSERT, UPDATE, DELETE ON lyx_probe_lock TO lyx_app;`);
  } finally {
    await owner.end();
  }
  [left, right] = await Promise.all([openClient(db), openClient(db)]);
  tx = createTxRunner({ prisma, appEnv: "test" });
}, SLOW);

afterAll(async () => {
  await Promise.all([left, right].map((client) => client?.$disconnect()));
});

/** 造一个积分包（不上架：上架中的积分数不能重复） */
async function pack(priceFen = 100): Promise<string> {
  const id = uuidv7();
  const now = clock.now();
  await prisma.pointPack.create({
    data: { id, points: 100, priceFen, isListed: false, createdAt: now, updatedAt: now },
  });
  return id;
}
const read = (id: string) => prisma.pointPack.findUniqueOrThrow({ where: { id } });

/** 一次内容编辑：先过版本关，再改内容 */
const edit = (
  runner: TxRunner,
  id: string,
  expected: number,
  priceFen: number,
  ready?: () => Promise<void>,
) =>
  runner.run(async (handle) => {
    await ready?.();
    const lockVersion = await bumpLockVersion(handle, { table: "point_pack", id, expected });
    await handle.pointPack.update({ where: { id }, data: { priceFen, updatedAt: clock.now() } });
    return lockVersion;
  });

describe("乐观锁：版本关（验收 9）", () => {
  it("版本一致：更新成功，版本加 1；连着改两次，每次都要带上一次返回的版本", async () => {
    const id = await pack();
    expect(await edit(tx, id, 0, 200)).toBe(1);
    expect(await read(id)).toMatchObject({ priceFen: 200, lockVersion: 1 });
    expect(await edit(tx, id, 1, 300)).toBe(2);
    expect(await read(id)).toMatchObject({ priceFen: 300, lockVersion: 2 });
  });

  it("版本不一致：409 VERSION_CONFLICT，details 带最新值；内容没动", async () => {
    const id = await pack();
    await edit(tx, id, 0, 200);
    for (const stale of [0, 5]) {
      await expect(edit(tx, id, stale, 999)).rejects.toMatchObject({
        name: "AppError",
        error: "VERSION_CONFLICT",
        details: { lockVersion: 1 },
      });
    }
    expect(COMMON_ERRORS.VERSION_CONFLICT).toMatchObject({ http: 409, code: 40901 });
    expect(await read(id)).toMatchObject({ priceFen: 200, lockVersion: 1 });
  });

  it("过了版本关之后事务回滚：版本不变，同一个版本还能再来", async () => {
    const id = await pack();
    const failed = new Error("后面的校验没过");
    const attempt = tx.run(async (handle) => {
      await bumpLockVersion(handle, { table: "point_pack", id, expected: 0 });
      throw failed;
    });
    await expect(attempt).rejects.toBe(failed);
    expect(await read(id)).toMatchObject({ lockVersion: 0 });
    expect(await edit(tx, id, 0, 200)).toBe(1);
  });

  it("行不存在：NOT_FOUND", async () => {
    await expect(edit(tx, uuidv7(), 0, 200)).rejects.toMatchObject({
      name: "AppError",
      error: "NOT_FOUND",
    });
  });

  it(
    `两条连接用同一个版本并发更新 ${ROUNDS} 轮：每轮只成功一个，另一个 VERSION_CONFLICT 且带最新值`,
    async () => {
      const id = await pack();
      const one = createTxRunner({ prisma: left, appEnv: "test" });
      const two = createTxRunner({ prisma: right, appEnv: "test" });
      const wins = { left: 0, right: 0 };
      for (let round = 0; round < ROUNDS; round += 1) {
        const label = `第 ${round + 1} 轮`;
        // 两个事务都开起来了才一起去过版本关
        const both = barrier(2);
        const prices = { left: 1_000 + round, right: 2_000 + round };
        const [a, b] = await Promise.allSettled([
          edit(one, id, round, prices.left, both),
          edit(two, id, round, prices.right, both),
        ]);
        const winner = a.status === "fulfilled" ? "left" : "right";
        const [won, lost] = winner === "left" ? [a, b] : [b, a];
        wins[winner] += 1;
        expect(won, label).toEqual({ status: "fulfilled", value: round + 1 });
        expect(lost, label).toMatchObject({
          status: "rejected",
          reason: { error: "VERSION_CONFLICT", details: { lockVersion: round + 1 } },
        });
        expect(await read(id), label).toMatchObject({
          priceFen: prices[winner],
          lockVersion: round + 1,
        });
      }
      expect(wins.left + wins.right).toBe(ROUNDS);
    },
    SLOW,
  );
});

describe("乐观锁：列名、主键列、字段名可指定", () => {
  const probe = async (code: string) => {
    await prisma.$executeRaw`INSERT INTO lyx_probe_lock (code) VALUES (${code})`;
    return async () => {
      const [row] = await prisma.$queryRaw<{ lockVersion: number; draftLockVersion: number }[]>`
        SELECT lock_version AS "lockVersion", draft_lock_version AS "draftLockVersion"
        FROM lyx_probe_lock WHERE code = ${code}`;
      return row;
    };
  };
  const key = { column: "code", type: "text" } as const;

  it("第二把锁 draft_lock_version：只动这一列，冲突时 details 的字段名是 draftLockVersion", async () => {
    const versions = await probe("plan-1");
    const target = { table: "lyx_probe_lock", id: "plan-1", key, column: "draft_lock_version" };
    expect(await tx.run((handle) => bumpLockVersion(handle, { ...target, expected: 0 }))).toBe(1);
    expect(await versions()).toEqual({ lockVersion: 0, draftLockVersion: 1 });
    // 行的 lock_version 是另一把锁，各管各的
    await tx.run((handle) =>
      bumpLockVersion(handle, { table: "lyx_probe_lock", id: "plan-1", key, expected: 0 }),
    );
    expect(await versions()).toEqual({ lockVersion: 1, draftLockVersion: 1 });

    await expect(
      tx.run((handle) => bumpLockVersion(handle, { ...target, expected: 0 })),
    ).rejects.toMatchObject({ error: "VERSION_CONFLICT", details: { draftLockVersion: 1 } });
  });

  it("父行锁：比对并推进父行的版本，details 的字段名由调用方给（dramaLockVersion）", async () => {
    const versions = await probe("drama-1");
    const parent = { table: "lyx_probe_lock", id: "drama-1", key, field: "dramaLockVersion" };
    expect(await tx.run((handle) => bumpLockVersion(handle, { ...parent, expected: 0 }))).toBe(1);
    await expect(
      tx.run((handle) => bumpLockVersion(handle, { ...parent, expected: 0 })),
    ).rejects.toMatchObject({ error: "VERSION_CONFLICT", details: { dramaLockVersion: 1 } });
    expect(await versions()).toEqual({ lockVersion: 1, draftLockVersion: 0 });
  });

  it("列名转字段名：lock_version → lockVersion，draft_lock_version → draftLockVersion", () => {
    expect(lockVersionField("lock_version")).toBe("lockVersion");
    expect(lockVersionField("draft_lock_version")).toBe("draftLockVersion");
    expect(lockVersionField("base_rev_no")).toBe("baseRevNo");
  });

  it("写错了代码：标识符不合规、主键不是 UUID、版本不是非负整数，抛 TypeError，一句 SQL 都不发", async () => {
    const id = await pack();
    const bad = [
      { table: 'point_pack"; DROP TABLE point_pack; --', id, expected: 0 },
      { table: "point_pack", id, expected: 0, column: "lock version" },
      { table: "point_pack", id, expected: 0, key: { column: "Id", type: "uuid" as const } },
      { table: "point_pack", id: "not-a-uuid", expected: 0 },
      { table: "point_pack", id, expected: -1 },
      { table: "point_pack", id, expected: 1.5 },
      { table: "point_pack", id, expected: 2 ** 31 },
    ];
    for (const target of bad) {
      await expect(tx.run((handle) => bumpLockVersion(handle, target))).rejects.toBeInstanceOf(
        TypeError,
      );
    }
    expect(await read(id)).toMatchObject({ lockVersion: 0 });
  });
});
