import { randomBytes } from "node:crypto";

import type { PrismaClient } from "@liyoxi/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useTestDatabase } from "../testing/index.js";
import { openClient } from "./__fixtures__/db.js";
import { uuidv7 } from "./ids.js";
import { assertLockOrder, checkLockOrder, LOCK_ORDER } from "./lock-order.js";
import type { LockTable } from "./lock-order.js";
import { lockRows } from "./lock.js";
import type { RowLockTable } from "./lock.js";
import { createTxRunner, savepoint, txState } from "./tx.js";
import type { HeldLock, KernelViolation, TxRunner } from "./tx.js";

// 验收第 1 条：先锁 drama_order（160）再锁 store（130）抛错；一个事务锁两个主体的 billing_account 抛错；
// 锁了 billing_account（420）之后再锁别的表抛错；按序加锁通过。
// 违规在发 SQL 之前就抛，所以前几例用不存在的主键；“真锁住了”一例往 merchant_user 里插两行。

const db = useTestDatabase("services");
let prisma: PrismaClient;
let other: PrismaClient;
let tx: TxRunner;

beforeAll(async () => {
  prisma = await db.prisma();
  other = await openClient(db);
  tx = createTxRunner({ prisma, appEnv: "test" });
}, 120_000);

afterAll(async () => {
  await other.$disconnect();
});

// 在句柄上 spy 会落到同一个客户端共用的对象上，不还原的话后面的事务都被记进去
afterEach(() => {
  vi.restoreAllMocks();
});

const violation = (message: RegExp) => ({ name: "KernelViolation", kind: "lock_order", message });
const held = (table: LockTable, key: string): HeldLock => ({ table, key });

describe("lockRows：锁序违规即抛错", () => {
  it("先锁 drama_order（160）再锁 store（130）抛错", async () => {
    await expect(
      tx.run(async (handle) => {
        await lockRows(handle, "drama_order", [uuidv7()]);
        await lockRows(handle, "store", [uuidv7()]);
      }),
    ).rejects.toMatchObject(violation(/已锁 drama_order（160），再锁 store（130）/));
  });

  it("一个事务锁两个主体的 billing_account 抛错：一次传两个、分两次锁都算", async () => {
    await expect(
      tx.run((handle) => lockRows(handle, "billing_account", [uuidv7(), uuidv7()])),
    ).rejects.toMatchObject(violation(/只锁一个主体的计费账户/));
    await expect(
      tx.run(async (handle) => {
        await lockRows(handle, "billing_account", [uuidv7()]);
        await lockRows(handle, "billing_account", [uuidv7()]);
      }),
    ).rejects.toMatchObject(violation(/只锁一个主体的计费账户/));
  });

  it("锁了 billing_account（420）之后再锁别的表抛错", async () => {
    await expect(
      tx.run(async (handle) => {
        await lockRows(handle, "billing_account", [uuidv7()]);
        await lockRows(handle, "file_object", [uuidv7()]);
      }),
    ).rejects.toMatchObject(violation(/锁了 billing_account 之后不能再锁 file_object/));
  });

  it("同一张表分两次锁，后一次的主键更小：抛错", async () => {
    const [low, high] = [uuidv7(), uuidv7()];
    await expect(
      tx.run(async (handle) => {
        await lockRows(handle, "order_item", [high as string]);
        await lockRows(handle, "order_item", [low as string]);
      }),
    ).rejects.toMatchObject(violation(/同一张表的多行按主键升序加锁/));
  });

  it("按序加锁通过：门店 → 广告 → 订购单 → 订单项 → 计费账户；重复锁已持有的行也通过", async () => {
    const account = uuidv7();
    const store = uuidv7();
    const items = [uuidv7(), uuidv7(), uuidv7()];
    const ledger = await tx.run(async (handle) => {
      await lockRows(handle, "store", [store], "share");
      await lockRows(handle, "ad", [uuidv7()]);
      await lockRows(handle, "drama_order", [uuidv7()]);
      // 一次传多行，顺序不论：函数里按主键升序排好再发
      await lockRows(handle, "order_item", [...items].reverse());
      await lockRows(handle, "billing_account", [account]);
      // 已持有的行再锁一遍（状态迁移里幂等的再锁）：不算违规。强度不变，或由排他要共享
      await lockRows(handle, "store", [store], "share");
      await lockRows(handle, "order_item", [items[0] as string]);
      await lockRows(handle, "order_item", [items[1] as string], "share");
      await lockRows(handle, "billing_account", [account]);
      return [...txState(handle).held];
    });
    expect(ledger.map((lock) => lock.table)).toEqual([
      "store",
      "ad",
      "drama_order",
      "order_item",
      "order_item",
      "order_item",
      "billing_account",
    ]);
    const itemKeys = ledger.filter((lock) => lock.table === "order_item").map((lock) => lock.key);
    expect(itemKeys).toEqual([...items].sort());
  });

  it("加锁顺序表之外的表、复合主键的 assignment_cursor 传不进 lockRows：编译不过", async () => {
    await tx.run(async (handle) => {
      // @ts-expect-error timer 不在加锁顺序表里（它总被主体行的锁支配，不参与排序）
      const outside = (): Promise<string[]> => lockRows(handle, "timer", [uuidv7()]);
      // @ts-expect-error assignment_cursor 是复合主键：自己写 SQL，先调 assertLockOrder
      const composite = (): Promise<string[]> => lockRows(handle, "assignment_cursor", [uuidv7()]);
      expect([outside, composite]).toHaveLength(2);
    });
  });

  it("只接受 UUID；空列表什么都不做", async () => {
    await tx.run(async (handle) => {
      expect(await lockRows(handle, "store", [])).toEqual([]);
      expect(txState(handle).held).toEqual([]);
      await expect(lockRows(handle, "store", ["1 OR 1=1"])).rejects.toThrow(TypeError);
    });
  });

  it("表名、强度运行时再核对一遍：强转进来的不拼进 SQL", async () => {
    await tx.run(async (handle) => {
      const sent = vi.spyOn(handle, "$queryRawUnsafe");
      const forged = [
        'store" WHERE false; DROP TABLE biz_sequence; --',
        "timer",
        "assignment_cursor",
        "toString",
      ].map((table) => lockRows(handle, table as RowLockTable, [uuidv7()]));
      for (const attempt of forged) await expect(attempt).rejects.toThrow(/只锁加锁顺序表里/);
      await expect(
        lockRows(handle, "store", [uuidv7()], "update; DROP TABLE x" as "update"),
      ).rejects.toThrow(/强度只有 update、share/);
      expect(sent).not.toHaveBeenCalled();
      sent.mockRestore();
      expect(txState(handle).held).toEqual([]);
    });
  });
});

// 复审：断言不记锁的强度，先共享、锁了后面的表、再把前面那一行升级成排他，被当成“再锁一遍”放行；
// 实际是一次新的等锁，两个事务都这么做会死锁。强度由 lockRows 记，升级按新加的锁再查一遍次序。
describe("lockRows：共享锁升级成排他锁按新加的锁查", () => {
  it("锁了次序更大的表之后回头升级：抛错；紧接着升级（后面什么都没锁）：通过", async () => {
    const store = uuidv7();
    await expect(
      tx.run(async (handle) => {
        await lockRows(handle, "store", [store], "share");
        await lockRows(handle, "drama_order", [uuidv7()]);
        await lockRows(handle, "store", [store]);
      }),
    ).rejects.toMatchObject(
      violation(/把共享锁升级成排他锁算一次新的加锁。.*已锁 drama_order（160），再锁 store（130）/),
    );
    await expect(
      tx.run(async (handle) => {
        await lockRows(handle, "store", [store], "share");
        await lockRows(handle, "billing_account", [uuidv7()]);
        await lockRows(handle, "store", [store], "update");
      }),
    ).rejects.toMatchObject(violation(/锁了 billing_account 之后不能再锁 store/));
    const ledger = await tx.run(async (handle) => {
      await lockRows(handle, "store", [store], "share");
      await lockRows(handle, "store", [store]);
      // 升级之后就是排他：再要共享、再要排他都只是再锁一遍
      await lockRows(handle, "drama_order", [uuidv7()]);
      await lockRows(handle, "store", [store], "share");
      await lockRows(handle, "store", [store]);
      return [...txState(handle).held];
    });
    expect(ledger).toEqual([
      { table: "store", key: store, mode: "share" },
      { table: "store", key: store, mode: "update" },
      { table: "drama_order", key: expect.any(String) as string, mode: "update" },
    ]);
  });

  it("同一张表：锁过主键更大的行之后升级主键小的那一行抛错；两行一起升级通过", async () => {
    const [low, high] = [uuidv7(), uuidv7()].sort() as [string, string];
    await expect(
      tx.run(async (handle) => {
        await lockRows(handle, "order_item", [low, high], "share");
        await lockRows(handle, "order_item", [low]);
      }),
    ).rejects.toMatchObject(violation(/升级成排他锁.*同一张表的多行按主键升序加锁/));
    await tx.run(async (handle) => {
      await lockRows(handle, "order_item", [low, high], "share");
      await lockRows(handle, "order_item", [high, low]);
    });
    // 主键大的那一行单独升级：它后面没有锁过别的，通过
    await tx.run(async (handle) => {
      await lockRows(handle, "order_item", [low, high], "share");
      await lockRows(handle, "order_item", [high]);
    });
  });

  it("保存点里升级、保存点回滚：强度退回共享，之后回头再升级照样抛错", async () => {
    const store = uuidv7();
    await expect(
      tx.run(async (handle) => {
        await lockRows(handle, "store", [store], "share");
        await savepoint(handle, async () => {
          await lockRows(handle, "store", [store]);
          throw new Error("保存点里失败");
        }).catch(() => {});
        expect(txState(handle).held).toEqual([{ table: "store", key: store, mode: "share" }]);
        await lockRows(handle, "ad", [uuidv7()]);
        await lockRows(handle, "store", [store]);
      }),
    ).rejects.toMatchObject(violation(/已锁 ad（150），再锁 store（130）/));
  });

  it("自己写加锁 SQL、只调了 assertLockOrder 的行不知道强度，按排他算：之后 lockRows 再锁不算升级", async () => {
    const staff = uuidv7();
    await tx.run(async (handle) => {
      assertLockOrder(handle, "staff", [staff]);
      await lockRows(handle, "store", [uuidv7()]);
      await lockRows(handle, "staff", [staff]);
    });
  });

  it("stg、prod：升级违规只上报，照常加锁", async () => {
    const reported: KernelViolation[] = [];
    const prod = createTxRunner({ prisma, appEnv: "prod", report: (v) => reported.push(v) });
    const store = uuidv7();
    await prod.run(async (handle) => {
      await lockRows(handle, "store", [store], "share");
      await lockRows(handle, "drama_order", [uuidv7()]);
      await lockRows(handle, "store", [store]);
    });
    expect(reported.map((v) => v.message)).toEqual([
      expect.stringMatching(/把共享锁升级成排他锁算一次新的加锁/),
    ]);
  });
});

describe("lockRows：真的发了加锁语句", () => {
  it("加锁顺序表里每一张表各发一遍：表名、主键列与库里的一致", async () => {
    const tables = Object.keys(LOCK_ORDER).filter(
      (table): table is RowLockTable => table !== "assignment_cursor",
    );
    await tx.run(async (handle) => {
      for (const table of tables) expect(await lockRows(handle, table, [uuidv7()])).toEqual([]);
      expect(txState(handle).held).toHaveLength(tables.length);
    });
  });

  it("锁到的行另一条连接拿不到；share 模式别人还能读着锁、不能改", async () => {
    const ids = [uuidv7(), uuidv7()].sort() as [string, string];
    const at = new Date("2026-01-05T04:00:00.000Z");
    await prisma.merchantUser.createMany({
      data: ids.map((id, index) => ({
        id,
        status: "active",
        sourceType: "organic",
        phoneEnc: `enc-${index}`,
        phoneBidx: randomBytes(32),
        phoneMask: "138****0000",
        phoneLast4: "0000",
        lastActiveAt: at,
        createdAt: at,
        updatedAt: at,
      })),
    });
    const probe = (id: string, clause: string): Promise<"free" | "held"> =>
      other
        .$queryRawUnsafe(`SELECT 1 FROM merchant_user WHERE id = $1::uuid ${clause} NOWAIT`, id)
        .then(
          () => "free" as const,
          (error: Error) => {
            if (error.message.includes("55P03")) return "held" as const;
            throw error;
          },
        );
    await tx.run(async (handle) => {
      // 乱序传入、带一个不存在的：返回实际锁到的，升序
      const sent = vi.spyOn(handle, "$queryRawUnsafe");
      const locked = await lockRows(handle, "merchant_user", [ids[1], uuidv7(), ids[0]]);
      expect(locked).toEqual(ids);
      // 复审的变异：SQL 去掉 ORDER BY，返回值照样是升序（碰巧）。一条语句锁多行，加锁的先后就是 ORDER BY 的先后
      expect(sent.mock.calls.map((call) => call[0])).toEqual([
        expect.stringMatching(/ = ANY\(\$1::uuid\[\]\) ORDER BY "id" FOR UPDATE$/),
      ]);
      expect(sent.mock.calls[0]?.[1]).toHaveLength(3);
      expect(sent.mock.calls[0]?.[1]).toEqual([...(sent.mock.calls[0]?.[1] as string[])].sort());
      sent.mockRestore();
      expect(await probe(ids[0], "FOR UPDATE")).toBe("held");
      expect(await probe(ids[1], "FOR SHARE")).toBe("held");
    });
    expect(await probe(ids[0], "FOR UPDATE")).toBe("free");
    await tx.run(async (handle) => {
      expect(await lockRows(handle, "merchant_user", [ids[0]], "share")).toEqual([ids[0]]);
      expect(await probe(ids[0], "FOR SHARE")).toBe("free");
      expect(await probe(ids[0], "FOR UPDATE")).toBe("held");
    });
  });
});

describe("锁序断言的其余约定", () => {
  it("保存点回滚后，保存点里加的锁不再算已持有", async () => {
    await tx.run(async (handle) => {
      await lockRows(handle, "store", [uuidv7()]);
      await savepoint(handle, async () => {
        await lockRows(handle, "drama_order", [uuidv7()]);
        throw new Error("保存点里失败");
      }).catch(() => {});
      expect(txState(handle).held.map((lock) => lock.table)).toEqual(["store"]);
      // drama_order（160）的锁已随保存点放掉：再锁 ad（150）不违规
      await lockRows(handle, "ad", [uuidv7()]);
    });
  });

  it("已知的限度：硬转去调句柄上 Prisma 自带的 $transaction，那层保存点内核不知道，锁序记录不跟着退", async () => {
    type Nested = { $transaction: (fn: () => Promise<void>) => Promise<void> };
    await tx.run(async (handle) => {
      await lockRows(handle, "store", [uuidv7()]);
      await (handle as unknown as Nested)
        .$transaction(async () => {
          await lockRows(handle, "drama_order", [uuidv7()]);
          throw new Error("内层失败");
        })
        .catch(() => {});
      // 库里 drama_order 的锁已随 Prisma 的保存点放掉，内核的记录还留着：之后锁 ad（150）被误报。
      // 所以句柄的类型去掉了 $transaction，局部回滚只走 savepoint（上一例）
      expect(txState(handle).held.map((lock) => lock.table)).toEqual(["store", "drama_order"]);
      await expect(lockRows(handle, "ad", [uuidv7()])).rejects.toMatchObject(violation(/顺序反了/));
    });
  });

  it("复合主键的 assignment_cursor：自己写 SQL 的地方先调 assertLockOrder", async () => {
    await tx.run(async (handle) => {
      assertLockOrder(handle, "assignment_cursor", ["cs:all"]);
      await lockRows(handle, "staff", [uuidv7()], "share");
    });
    await expect(
      tx.run(async (handle) => {
        await lockRows(handle, "staff", [uuidv7()], "share");
        assertLockOrder(handle, "assignment_cursor", ["cs:all"]);
      }),
    ).rejects.toMatchObject(violation(/已锁 staff（20），再锁 assignment_cursor（10）/));
  });

  it("stg、prod：不抛错，上报后照常加锁", async () => {
    const reported: KernelViolation[] = [];
    const prod = createTxRunner({ prisma, appEnv: "prod", report: (v) => reported.push(v) });
    const ledger = await prod.run(async (handle) => {
      await lockRows(handle, "drama_order", [uuidv7()]);
      await lockRows(handle, "store", [uuidv7()]);
      return txState(handle).held.map((lock) => lock.table);
    });
    expect(ledger).toEqual(["drama_order", "store"]);
    expect(reported.map((v) => v.kind)).toEqual(["lock_order"]);
  });

  it("checkLockOrder：判定本身（不连库）", () => {
    expect(checkLockOrder([], "store", ["b", "a"])).toBeUndefined();
    expect(checkLockOrder([held("store", "a")], "store", ["a"])).toBeUndefined();
    expect(checkLockOrder([held("store", "a")], "store", ["b"])).toBeUndefined();
    expect(checkLockOrder([held("store", "b")], "store", ["a"])).toMatch(/升序/);
    expect(checkLockOrder([held("store", "a")], "drama_order", ["a"])).toBeUndefined();
    expect(checkLockOrder([held("drama_order", "a")], "store", ["z"])).toMatch(/顺序反了/);
    // 中间夹着次序更大的表：回头再锁小的也违规
    expect(checkLockOrder([held("store", "a"), held("order_item", "a")], "store", ["b"])).toMatch(
      /已锁 order_item（170），再锁 store（130）/,
    );
    expect(
      checkLockOrder([held("billing_account", "a")], "billing_account", ["a"]),
    ).toBeUndefined();
    expect(checkLockOrder([held("billing_account", "a")], "billing_account", ["b"])).toMatch(
      /只锁一个主体/,
    );
    expect(checkLockOrder([], "billing_account", ["a", "b"])).toMatch(/只锁一个主体/);
  });
});
