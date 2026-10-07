import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "../testing/index.js";
import { barrier, bump, openClient, probeRowLock, put, rows } from "./__fixtures__/db.js";
import { idemRows, merchant, requestOf } from "./__fixtures__/idempotency.js";
import { assertLockOrder } from "./lock-order.js";
import { createTxRunner, detach, isInTransaction, savepoint, txState } from "./tx.js";
import type { TxRunner } from "./tx.js";

const db = useTestDatabase("services");
let prisma: PrismaClient;
let inspect: PrismaClient;
let tx: TxRunner;

beforeAll(async () => {
  prisma = await openClient(db, { max: 4 });
  inspect = await openClient(db);
  tx = createTxRunner({ prisma, appEnv: "test" });
}, 120_000);
afterAll(async () => {
  await Promise.all([prisma.$disconnect(), inspect.$disconnect()]);
});

describe("detach：独立事务的真库边界", () => {
  it("内层提交后外层回滚，内层结果仍可从另一连接读到", async () => {
    const boom = new Error("外层失败");
    await expect(
      tx.run(async (outer) => {
        await put(outer, "DA");
        await detach(() => tx.run((inner) => put(inner, "DB")));
        expect((await rows(inspect)).DB).toBe(1);
        expect((await rows(inspect)).DA).toBeUndefined();
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await rows(inspect)).toMatchObject({ DB: 1 });
    expect((await rows(inspect)).DA).toBeUndefined();
  });

  it("内层业务失败只回滚内层，恢复后外层还能写并提交", async () => {
    const boom = new Error("独立失败");
    await tx.run(async (outer) => {
      await put(outer, "DC");
      await expect(
        detach(() =>
          tx.run(async (inner) => {
            await put(inner, "DD");
            throw boom;
          }),
        ),
      ).rejects.toBe(boom);
      expect(isInTransaction()).toBe(true);
      await put(outer, "DE");
    });
    const saved = await rows(inspect);
    expect(saved).toMatchObject({ DC: 1, DE: 1 });
    expect(saved.DD).toBeUndefined();
  });

  it("内层数据库失败不污染外层连接", async () => {
    await put(prisma, "DU");
    await tx.run(async (outer) => {
      await put(outer, "DF");
      await expect(detach(() => tx.run((inner) => put(inner, "DU")))).rejects.toThrow();
      await put(outer, "DG");
    });
    expect(await rows(inspect)).toMatchObject({ DU: 1, DF: 1, DG: 1 });
  });

  it("外层锁仍持有；独立事务锁序/保存点为空，结束后外层原状态保留", async () => {
    await put(prisma, "DL");
    await tx.run(async (outer) => {
      await bump(outer, "DL");
      assertLockOrder(outer, "billing_account", ["outer-account"]);
      await savepoint(outer, async () => null);
      const before = txState(outer);
      await detach(() =>
        tx.run(async (inner) => {
          expect(txState(inner).held).toEqual([]);
          expect(txState(inner).savepoints).toBe(0);
          assertLockOrder(inner, "staff", ["independent-staff"]);
          await savepoint(inner, () => put(inner, "DI"));
        }),
      );
      expect(txState(outer)).toBe(before);
      expect(before.held).toEqual([{ table: "billing_account", key: "outer-account" }]);
      expect(before.savepoints).toBe(1);
      expect(await probeRowLock(inspect, "DL")).toBe("held");
    });
    expect(await probeRowLock(inspect, "DL")).toBe("free");
  });

  it("外层句柄、已取的模型delegate/方法和原生SQL不能偷带到独立链", async () => {
    await tx.run(async (outer) => {
      const delegate = outer.bizSequence;
      const create = delegate.create.bind(delegate);
      const query = outer.$queryRawUnsafe.bind(outer);
      await detach(async () => {
        expect(() => txState(outer)).toThrow(/外层事务句柄/);
        expect(() => query("SELECT 1")).toThrow(/外层事务句柄/);
        expect(() =>
          create({ data: { prefix: "DX", bizDate: new Date("2026-01-05"), nextVal: 1 } }),
        ).toThrow(/外层事务句柄/);
        await expect(savepoint(outer, async () => null)).rejects.toThrow(/外层事务句柄/);
        await tx.run(async () => {
          expect(() => outer.bizSequence.count()).toThrow(/外层事务句柄/);
        });
      });
      await put(outer, "DY");
    });
    expect((await rows(inspect)).DX).toBeUndefined();
    expect((await rows(inspect)).DY).toBe(1);
  });

  it("预先构造但未执行的 Prisma 查询也不能延迟到脱离链使用", async () => {
    await tx.run(async (outer) => {
      const model = put(outer, "DZ");
      const raw = outer.$queryRawUnsafe("SELECT 1");
      await detach(async () => {
        await expect(model).rejects.toThrow(/外层事务句柄/);
        await expect(raw).rejects.toThrow(/外层事务句柄/);
      });
      await put(outer, "DW");
    });
    expect((await rows(inspect)).DZ).toBeUndefined();
    expect((await rows(inspect)).DW).toBe(1);
  });

  it("两个外层与两个独立事务并发，回滚与提交不会串作用域", async () => {
    const bothOuter = barrier(2);
    const bothInner = barrier(2);
    const boom = new Error("第一外层失败");
    const first = tx.run(async (outer) => {
      await put(outer, "PA");
      await bothOuter();
      await detach(() =>
        tx.run(async (inner) => {
          await bothInner();
          await put(inner, "PI");
        }),
      );
      expect(isInTransaction()).toBe(true);
      throw boom;
    });
    const second = tx.run(async (outer) => {
      await put(outer, "PB");
      await bothOuter();
      await detach(() =>
        tx.run(async (inner) => {
          await bothInner();
          await put(inner, "PJ");
        }),
      );
      expect(isInTransaction()).toBe(true);
    });
    const settled = await Promise.allSettled([first, second]);
    expect(settled).toEqual([
      { status: "rejected", reason: boom },
      { status: "fulfilled", value: undefined },
    ]);
    const saved = await rows(inspect);
    expect(saved).toMatchObject({ PB: 1, PI: 1, PJ: 1 });
    expect(saved.PA).toBeUndefined();
    expect(isInTransaction()).toBe(false);
  });

  it("独立幂等提交不随外层回滚，不自动继承或复用外层上下文", async () => {
    const actor = merchant();
    const outerIdem = requestOf(actor, "detach:outer");
    const innerIdem = requestOf(actor, "detach:inner");
    const boom = new Error("回滚幂等外层");
    await expect(
      tx.run(
        async (outer) => {
          await put(outer, "IA");
          await expect(
            detach(() => tx.run(async () => null, { idem: outerIdem })),
          ).rejects.toMatchObject({ kind: "idempotency_context_reused" });
          await detach(() =>
            tx.run(
              async (inner) => {
                await put(inner, "IB");
                return { ok: true };
              },
              { idem: innerIdem },
            ),
          );
          throw boom;
        },
        { idem: outerIdem },
      ),
    ).rejects.toBe(boom);
    const saved = await idemRows(inspect);
    expect(saved.filter((row) => row.key === "detach:outer")).toEqual([]);
    expect(saved.filter((row) => row.key === "detach:inner")).toMatchObject([
      { state: "done", result: { ok: true } },
    ]);
    expect(await rows(inspect)).toMatchObject({ IB: 1 });
    expect((await rows(inspect)).IA).toBeUndefined();
    expect(innerIdem.replayed).toBe(false);
  });
});
