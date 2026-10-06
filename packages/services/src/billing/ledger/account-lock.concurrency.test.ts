import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isAppError, savepoint, uuidv7 } from "../../kernel/index.js";
import {
  createLedgerHarness,
  dramaHoldInput,
  joinLedger,
  openTerm,
  ownerContext,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness } from "../../testing/index.js";
import { ACCOUNT_LOCK_WAIT_MS, LedgerError } from "./index.js";

// 验收 4（甲类的并发测试）：等锁 3 秒。账户锁被另一条连接占着：加购入账在 3 到 4 秒之间得到 ACCOUNT_BUSY，
// 不进 tx.run 的重试（进了的话是 6 秒以上、拿到的是 BUSY）；放开之后同一个键重试成功，只入账一次。
// 一个事务锁第二个主体的账户即抛错。冻结（hold）走的是同一个入口，第二个 PR 补了一条：
// 冻结等锁 3 秒；同一事务再次进入而锁已随保存点回滚丢掉时，重新拿锁同样只等 3 秒。

const SLOW = 120_000;

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: LedgerHarness;
let other: Awaited<ReturnType<typeof joinLedger>>;
let freshConnection: Awaited<ReturnType<typeof joinLedger>>;

beforeAll(async () => {
  prisma = await db.prisma();
  h = createLedgerHarness(prisma);
  other = await joinLedger(h, await db.url());
  freshConnection = await joinLedger(h, await db.url());
}, SLOW);

afterAll(async () => {
  await other?.close();
  await freshConnection?.close();
});

/** 一个可以从外面放行的门 */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe("账户锁（验收 4）", () => {
  it("等锁上限是 3 秒", () => {
    expect(ACCOUNT_LOCK_WAIT_MS).toBe(3_000);
  });

  it(
    "锁被占着：3 到 4 秒之间得到 ACCOUNT_BUSY（503、可重试），不重试；放开后同键重试成功，只入账一次",
    async () => {
      const { entity, user } = await h.make.merchant({ verified: true });
      await openTerm(h, { entityId: entity.id });
      const order = await h.make.billingOrder({
        entityId: entity.id,
        type: "topup",
        amountFen: 100_000,
      });
      const input = {
        entityId: entity.id,
        billingOrderId: order.id,
        points: 1000,
        payFen: 100_000,
        ctx: ownerContext(entity.id, user.id),
      };

      const locked = gate();
      const release = gate();
      // 另一条连接进入账本并占着账户锁，直到放行
      const holder = other.tx.run(
        async (tx) => {
          await other.ledger.lockAccount(tx, entity.id);
          locked.open();
          await release.opened;
        },
        { timeoutMs: 30_000 },
      );
      await locked.opened;

      const startedAt = performance.now();
      const outcome = await h.tx
        .run((tx) => h.ledger.purchase(tx, input))
        .then(
          () => "入账了",
          (error: unknown) => error,
        );
      const waitedMs = performance.now() - startedAt;
      release.open();
      await holder;

      expect(isAppError(outcome) && outcome.error).toBe("ACCOUNT_BUSY");
      expect(waitedMs).toBeGreaterThanOrEqual(ACCOUNT_LOCK_WAIT_MS - 100);
      expect(waitedMs).toBeLessThan(ACCOUNT_LOCK_WAIT_MS + 1_000);
      expect(await prisma.pointLot.count({ where: { entityId: entity.id, kind: "addon" } })).toBe(
        0,
      );

      const retried = await h.tx.run((tx) => h.ledger.purchase(tx, input));
      expect(retried).toMatchObject({ points: 1000, replayed: false });
      expect(await prisma.pointLot.count({ where: { entityId: entity.id, kind: "addon" } })).toBe(
        1,
      );
    },
    SLOW,
  );

  it(
    "冻结等锁 3 秒；同一事务再次进入而锁已随保存点回滚丢掉：重新拿锁也是 3 到 4 秒得到 ACCOUNT_BUSY。放开后同键重试成功",
    async () => {
      const { entity, store } = await h.make.merchant({ verified: true });
      await openTerm(h, { entityId: entity.id });
      const drama = await h.make.drama({ heatTier: "A" });
      const order = { entityId: entity.id, storeId: store.id, dramaId: drama.id };
      const [fresh, reentered] = [
        dramaHoldInput({ ...order, refId: uuidv7() }),
        dramaHoldInput({ ...order, refId: uuidv7() }),
      ];

      const lost = gate();
      const locked = gate();
      const release = gate();
      const timed = async (run: () => Promise<unknown>) => {
        const startedAt = performance.now();
        const outcome = await run().then(
          () => "冻结了",
          (error: unknown) => error,
        );
        return { outcome, waitedMs: performance.now() - startedAt };
      };
      // 这个事务先在保存点里进入账本，保存点回滚，账户锁随之释放；等另一条连接占住锁之后再冻结
      const second = h.tx
        .run(
          async (tx) => {
            await savepoint(tx, async () => {
              await h.ledger.lockAccount(tx, entity.id);
              throw new Error("回滚这个保存点");
            }).catch(() => undefined);
            lost.open();
            await locked.opened;
            // 超时的 SQL 会中止当前事务；保存点回滚后仍能提交计时结果。
            return timed(() => savepoint(tx, () => h.ledger.hold(tx, reentered)));
          },
          { timeoutMs: 30_000 },
        )
        .catch((error: unknown) => ({ outcome: error, waitedMs: -1 }));
      await lost.opened;
      const holder = other.tx.run(
        async (tx) => {
          await other.ledger.lockAccount(tx, entity.id);
          locked.open();
          await release.opened;
        },
        { timeoutMs: 30_000 },
      );
      await locked.opened;
      // 另一个事务第一次进入：照常等 3 秒
      const first = await timed(() =>
        freshConnection.tx.run((tx) => freshConnection.ledger.hold(tx, fresh)),
      );
      const again = await second;
      release.open();
      await holder;

      for (const [entry, { outcome, waitedMs }] of [first, again].entries()) {
        expect(isAppError(outcome) && outcome.error).toBe("ACCOUNT_BUSY");
        expect(waitedMs).toBeGreaterThanOrEqual(ACCOUNT_LOCK_WAIT_MS - 100);
        expect(waitedMs, entry === 0 ? "首次进入" : "保存点回滚后再次进入").toBeLessThan(
          ACCOUNT_LOCK_WAIT_MS + 1_000,
        );
      }
      expect(await prisma.pointHold.count({ where: { entityId: entity.id } })).toBe(0);
      for (const input of [fresh, reentered]) {
        expect(await h.tx.run((tx) => h.ledger.hold(tx, input))).toMatchObject({
          points: 1800,
          replayed: false,
        });
      }
    },
    SLOW,
  );

  it(
    "3 秒只管拿账户锁这一句：拿到之后连接的 lock_timeout 与 statement_timeout 恢复原值；沿用更短的语句超时",
    async () => {
      const { entity } = await h.make.merchant();
      const setting = (tx: { $queryRaw: PrismaClient["$queryRaw"] }) =>
        tx.$queryRaw<{ lock: string; statement: string }[]>`
          SELECT current_setting('lock_timeout') AS lock,
                 current_setting('statement_timeout') AS statement`;
      const [before, after] = await h.tx.run(async (tx) => {
        await tx.$queryRaw`
          SELECT set_config('lock_timeout', '7s', true),
                 set_config('statement_timeout', '2s', true)`;
        const [was] = await setting(tx);
        await h.ledger.lockAccount(tx, entity.id);
        const [now] = await setting(tx);
        return [was, now];
      });
      expect(before).toEqual({ lock: "7s", statement: "2s" });
      expect(after).toEqual(before);
    },
    SLOW,
  );

  it.each(["statement_timeout", "lock_timeout"])(
    "连接原有 %s 更短：只等 1 秒且仍映射 ACCOUNT_BUSY",
    async (setting) => {
      const { entity, store } = await h.make.merchant({ verified: true });
      await openTerm(h, { entityId: entity.id });
      const drama = await h.make.drama({ heatTier: "A" });
      const locked = gate();
      const release = gate();
      const holder = other.tx.run(async (tx) => {
        await other.ledger.lockAccount(tx, entity.id);
        locked.open();
        await release.opened;
      });
      await locked.opened;
      const startedAt = performance.now();
      const outcome = await freshConnection.tx
        .run(async (tx) => {
          await tx.$queryRaw`SELECT set_config(${setting}, '1s', true)`;
          return freshConnection.ledger.hold(
            tx,
            dramaHoldInput({
              entityId: entity.id,
              storeId: store.id,
              dramaId: drama.id,
              refId: uuidv7(),
            }),
          );
        })
        .catch((error: unknown) => error);
      const waitedMs = performance.now() - startedAt;
      release.open();
      await holder;
      expect(isAppError(outcome) && outcome.error).toBe("ACCOUNT_BUSY");
      expect(waitedMs).toBeGreaterThanOrEqual(900);
      expect(waitedMs).toBeLessThan(2_000);
    },
    SLOW,
  );

  it(
    "每分钟扫描的拿法：锁被占着就不等，立刻返回 null；放开后照常推进",
    async () => {
      const { entity } = await h.make.merchant();
      const locked = gate();
      const release = gate();
      const holder = other.tx.run(async (tx) => {
        await other.ledger.lockAccount(tx, entity.id);
        locked.open();
        await release.opened;
      });
      await locked.opened;
      const startedAt = performance.now();
      const skipped = await h.tx.run((tx) => h.ledger.advance(tx, entity.id, { wait: "skip" }));
      expect(skipped).toBeNull();
      expect(performance.now() - startedAt).toBeLessThan(ACCOUNT_LOCK_WAIT_MS - 1_000);
      release.open();
      await holder;
      expect(
        await h.tx.run((tx) => h.ledger.advance(tx, entity.id, { wait: "skip" })),
      ).toMatchObject({ granted: 0 });
    },
    SLOW,
  );

  it(
    "一个事务只锁一个主体的账户：锁第二个即抛错，事务回滚",
    async () => {
      const first = await h.make.merchant();
      const second = await h.make.merchant();
      const error = await h.tx
        .run(async (tx) => {
          await h.ledger.lockAccount(tx, first.entity.id);
          await h.ledger.lockAccount(tx, second.entity.id);
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).reason).toBe("one_account_per_tx");
      // 同一个主体再进入不算
      await h.tx.run(async (tx) => {
        await h.ledger.lockAccount(tx, first.entity.id);
        await h.ledger.lockAccount(tx, first.entity.id);
      });
    },
    SLOW,
  );
});
