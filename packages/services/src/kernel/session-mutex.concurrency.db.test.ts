import { createSessionMutexConnectionFactory } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase, createFakeProviders, useTestDatabase } from "../testing/index.js";
import { barrier, gate, openClient, put, rows } from "./__fixtures__/db.js";
import { createSessionMutex } from "./session-mutex.js";
import { createTxRunner } from "./tx.js";
import { uuidv7 } from "./ids.js";

const db = useTestDatabase("services", { label: "sessmutex", max: 1 });
const isolated = useTestDatabase("services", { label: "sessiso", max: 1 });
let url: string, isolatedUrl: string;
beforeAll(async () => {
  url = await db.url();
  isolatedUrl = await isolated.url();
}, 120000);
const mutexOf = (connectionString = url, tag = `lyxtest_mutex_${uuidv7()}`) =>
  createSessionMutex({
    connect: createSessionMutexConnectionFactory({ connectionString, applicationName: tag }),
    probeMs: 50,
  });

describe("专用session advisory互斥真实数据库边界", { timeout: 120000 }, () => {
  it("同key跨两个业务TX和事务外Provider期间始终互斥，业务max1不死锁", async () => {
    const mutex = mutexOf(),
      rival = mutexOf();
    const first = await openClient(db, { max: 1 }),
      second = await openClient(db, { max: 1 });
    const claim = createTxRunner({ prisma: first, appEnv: "test" }),
      settle = createTxRunner({ prisma: second, appEnv: "test" });
    const providers = createFakeProviders(),
      ref = { bucket: "secure" as const, key: "lyxtest/mutex.pdf" };
    const gapReady = gate(),
      continueOwner = gate();
    providers.storage.put(ref, new Uint8Array([1]), "application/pdf");
    let entered = false;
    try {
      const running = mutex.run("media:file:two-tx", async (scope) => {
        await claim.run(async (tx) => {
          await put(tx, "MA");
          await expect(providers.storage.head(ref)).rejects.toMatchObject({
            kind: "external_call_in_transaction",
          });
          await expect(mutex.run("media:file:nested", async () => undefined)).rejects.toMatchObject(
            { kind: "nested_transaction" },
          );
          await expect(claim.run(async () => undefined)).rejects.toMatchObject({
            kind: "nested_transaction",
          });
        });
        // 先关第一条业务连接，竞争时实际仅两条互斥物理会话。
        await first.$disconnect();
        gapReady.open();
        await continueOwner.opened;
        expect((await providers.storage.head(ref)).ok).toBe(true);
        await scope.assertHeld();
        await settle.run((tx) => put(tx, "MB"));
        return "settled";
      });
      await Promise.race([gapReady.opened, running]);
      // 竞争方从原调用链启动，不继承持锁回调的ALS嵌套作用域。
      await expect(
        rival.run("media:file:two-tx", async () => {
          entered = true;
        }),
      ).rejects.toMatchObject({ reason: "occupied" });
      expect(entered).toBe(false);
      continueOwner.open();
      expect(await running).toBe("settled");
      expect(await rows(second)).toMatchObject({ MA: 1, MB: 1 });
      await second.$disconnect();
      expect(await rival.run("media:file:two-tx", async () => "taken-after-release")).toBe(
        "taken-after-release",
      );
    } finally {
      continueOwner.open();
      await Promise.all([mutex.close(), rival.close(), first.$disconnect(), second.$disconnect()]);
    }
  });

  it("different key真实并行；相同key在两独立数据库不互相阻塞", async () => {
    const left = mutexOf(),
      right = mutexOf(),
      otherDatabase = mutexOf(isolatedUrl);
    try {
      const meet = barrier(2),
        entered: string[] = [];
      await Promise.all([
        left.run("media:file:A", async (scope) => {
          entered.push("A");
          await meet();
          await scope.assertHeld();
        }),
        right.run("media:file:B", async (scope) => {
          entered.push("B");
          await meet();
          await scope.assertHeld();
        }),
      ]);
      expect(entered.sort()).toEqual(["A", "B"]);
      const same = barrier(2);
      const result = await Promise.all([
        left.run("media:file:same-db-key", async (scope) => {
          await same();
          await scope.assertHeld();
          return "first-db";
        }),
        otherDatabase.run("media:file:same-db-key", async (scope) => {
          await same();
          await scope.assertHeld();
          return "second-db";
        }),
      ]);
      expect(result).toEqual(["first-db", "second-db"]);
    } finally {
      await Promise.all([left.close(), right.close(), otherDatabase.close()]);
    }
  });

  it("真实断连自动释放；旧回调忽略abort仍不能启动第二TX写入", async () => {
    const tag = `lyxtest_mutex_lost_${uuidv7()}`,
      mutex = mutexOf(url, tag),
      next = mutexOf();
    const client = await openClient(db, { max: 1 }),
      tx = createTxRunner({ prisma: client, appEnv: "test" });
    const ready = gate(),
      continueOld = gate();
    let signal: AbortSignal | undefined,
      attempted = false;
    const running = mutex.run("media:file:disconnect", async (scope) => {
      signal = scope.signal;
      await tx.run((handle) => put(handle, "LC"));
      ready.open();
      await continueOld.opened;
      attempted = true;
      await expect(tx.run((handle) => put(handle, "LD"))).rejects.toMatchObject({ reason: "lost" });
    });
    const rejected = expect(running).rejects.toMatchObject({ reason: "lost" });
    let control: Awaited<ReturnType<typeof connectTestDatabase>> | undefined;
    try {
      await ready.opened;
      await client.$disconnect();
      // 仅本文件隔离库/唯一application_name，控制连接与持锁连接共两条。
      control = await connectTestDatabase(db.name, { role: null });
      const killed = await control.query<{ terminated: boolean }>(
        "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND pid<>pg_backend_pid()",
        [tag],
      );
      expect(killed.rows).toEqual([{ terminated: true }]);
      await rejected;
      expect(signal!.aborted).toBe(true);
      continueOld.open();
      await mutex.close();
      expect(attempted).toBe(true);
      await control.end();
      control = undefined;
      expect(await next.run("media:file:disconnect", async () => "new-owner")).toBe("new-owner");
      const inspect = await openClient(db, { max: 1 });
      try {
        expect(await rows(inspect)).toMatchObject({ LC: 1 });
        expect((await rows(inspect)).LD).toBeUndefined();
      } finally {
        await inspect.$disconnect();
      }
    } finally {
      continueOld.open();
      await control?.end();
      await Promise.all([mutex.close(), next.close(), client.$disconnect()]);
    }
  });

  it("关闭取消真实持锁会话并等待业务drain；预建惰性查询与提交均回滚", async () => {
    const mutex = mutexOf(),
      client = await openClient(db, { max: 1 }),
      tx = createTxRunner({ prisma: client, appEnv: "test" });
    const ready = gate(),
      continueTx = gate();
    let lateRejected = false,
      closingDone = false;
    const running = mutex.run("media:file:shutdown", async () =>
      tx.run(async (handle) => {
        await put(handle, "MC");
        const lazy = put(handle, "ML");
        ready.open();
        await continueTx.opened;
        await expect(lazy).rejects.toMatchObject({ reason: "closed" });
        lateRejected = true;
        // 即使吞了句柄拒绝，tx.run提交前仍须拒绝并回滚MC。
      }),
    );
    const rejected = expect(running).rejects.toMatchObject({ reason: "closed" });
    try {
      await ready.opened;
      const closing = mutex.close();
      void closing.then(() => {
        closingDone = true;
      });
      expect(mutex.close()).toBe(closing);
      await expect(mutex.run("media:file:new", async () => undefined)).rejects.toMatchObject({
        reason: "closed",
      });
      await rejected;
      expect(closingDone).toBe(false);
      continueTx.open();
      await closing;
      expect(lateRejected).toBe(true);
      const found = await rows(client);
      expect(found.MC).toBeUndefined();
      expect(found.ML).toBeUndefined();
    } finally {
      continueTx.open();
      await mutex.close();
      await client.$disconnect();
    }
  });
});
