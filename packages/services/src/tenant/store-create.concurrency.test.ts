import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import { connectTestDatabase, useSeededDatabase } from "../testing/index.js";
import { BODY, SLOW, storeHarness } from "./__fixtures__/store-create.js";
import type { StoreHarness } from "./__fixtures__/store-create.js";

const db = useSeededDatabase("services", { label: "createconc", max: 1 });
let h: StoreHarness, clients: PrismaClient[], pids: number[];
beforeAll(async () => {
  // 数据库建立完成后才连接；严格两个业务pool各max1，另一个只读observer。
  const url = await db.url();
  clients = [0, 1].map(() => createPrismaClient({ connectionString: url, max: 1 }));
  h = await storeHarness(clients[0]!);
  pids = await Promise.all(
    clients.map(async (client) => {
      const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (!row) throw new Error("真实业务PID缺失");
      return row.pid;
    }),
  );
  expect(new Set(pids).size).toBe(2);
}, SLOW);
afterAll(async () => {
  await Promise.all(clients?.map((client) => client.$disconnect()) ?? []);
}, SLOW);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("公开真实锁栅栏超时")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function blocked(
  observer: Awaited<ReturnType<typeof connectTestDatabase>>,
  waiter: number,
  holder: number,
) {
  const end = Date.now() + 3000;
  do {
    const found = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
      [waiter, holder],
    );
    if (found.rows[0]?.blocked) return;
    await new Promise((done) => setTimeout(done, 15));
  } while (Date.now() < end);
  throw new Error("未观察到两个具名业务连接的阻塞");
}
function error(result: PromiseSettledResult<unknown>) {
  expect(result.status).toBe("rejected");
  const value: unknown = result.status === "rejected" ? result.reason : null;
  expect(isAppError(value)).toBe(true);
  return isAppError(value) ? value.error : null;
}
async function held(
  write: (tx: Tx) => Promise<void>,
  read: () => Promise<unknown>,
  waiting?: () => void,
) {
  const entered = gate(),
    release = gate(),
    observer = await connectTestDatabase(db.name, { role: null });
  const first = Promise.allSettled([
    h.tx.run(async (tx) => {
      await write(tx);
      entered.release();
      await release.promise;
    }),
  ]);
  let second: ReturnType<typeof Promise.allSettled> | undefined;
  try {
    await bounded(entered.promise);
    second = Promise.allSettled([read()]);
    await blocked(observer, pids[1]!, pids[0]!);
    waiting?.();
    release.release();
    expect((await bounded(first))[0]?.status).toBe("fulfilled");
    return (await bounded(second))[0]!;
  } finally {
    release.release();
    await first;
    if (second) await second;
    await observer.end();
  }
}

describe("新增分店的真实两业务连接与锁后事实", { timeout: SLOW }, () => {
  it("两次真实创建抢最后一格，唯一赢家/事件/初始化且失败同键可后续恢复", async () => {
    const w = await h.owner();
    await h.prisma.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 2 } });
    const entered = gate(),
      release = gate(),
      observer = await connectTestDatabase(db.name, { role: null });
    const firstSide = h.side(clients[0]!, undefined, {
      initialize: async (...args) => {
        await h.ports.initialize(...args);
        entered.release();
        await release.promise;
      },
    });
    const secondSide = h.side(clients[1]!),
      key = uuidv7();
    const first = Promise.allSettled([h.create(w, BODY, firstSide.tenant)]);
    let second: ReturnType<typeof Promise.allSettled> | undefined;
    try {
      await bounded(entered.promise);
      second = Promise.allSettled([h.create(w, BODY, secondSide.tenant, key)]);
      await blocked(observer, pids[1]!, pids[0]!);
      release.release();
      expect((await bounded(first))[0]?.status).toBe("fulfilled");
      expect(error((await bounded(second))[0]!)).toBe("STORE_LIMIT_REACHED");
      expect(
        await h.prisma.store.count({ where: { entityId: w.entityId, lifecycle: "active" } }),
      ).toBe(2);
      expect(await h.prisma.storeProfile.count({ where: { entityId: w.entityId } })).toBe(1);
      expect(
        await h.prisma.outboxEvent.count({
          where: { entityId: w.entityId, eventType: "store.created" },
        }),
      ).toBe(2);
      await h.prisma.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 3 } });
      expect(await h.create(w, BODY, secondSide.tenant, key)).toMatchObject({
        lifecycle: "active",
      });
    } finally {
      release.release();
      await first;
      if (second) await second;
      await observer.end();
    }
  });

  it("真实创建占用最后一格后，恢复门店在同主体锁下重新计算额度", async () => {
    const w = await h.owner(),
      archived = await h.make.store({ entityId: w.entityId });
    await h.tenant.archiveStore(w.ctx, { storeId: archived.id });
    await h.prisma.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 2 } });
    const entered = gate(),
      release = gate(),
      observer = await connectTestDatabase(db.name, { role: null });
    const firstSide = h.side(clients[0]!, undefined, {
      initialize: async (...args) => {
        await h.ports.initialize(...args);
        entered.release();
        await release.promise;
      },
    });
    const first = Promise.allSettled([h.create(w, BODY, firstSide.tenant)]);
    let second: ReturnType<typeof Promise.allSettled> | undefined;
    try {
      await bounded(entered.promise);
      second = Promise.allSettled([
        h.side(clients[1]!).tenant.restoreStore(w.ctx, { storeId: archived.id }),
      ]);
      await blocked(observer, pids[1]!, pids[0]!);
      release.release();
      expect((await bounded(first))[0]?.status).toBe("fulfilled");
      expect(error((await bounded(second))[0]!)).toBe("STORE_LIMIT_REACHED");
      expect(await h.prisma.store.findUniqueOrThrow({ where: { id: archived.id } })).toMatchObject({
        lifecycle: "archived",
        archiveReason: "by_owner",
      });
    } finally {
      release.release();
      await first;
      if (second) await second;
      await observer.end();
    }
  });

  it("恢复赢家提交后，创建等待同主体锁并按真实额度拒绝", async () => {
    const w = await h.owner(),
      archived = await h.make.store({ entityId: w.entityId });
    await h.tenant.archiveStore(w.ctx, { storeId: archived.id });
    await h.prisma.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 2 } });
    const entered = gate(),
      release = gate(),
      observer = await connectTestDatabase(db.name, { role: null });
    const runner: TxRunner = {
      run: (fn, options) =>
        h.tx.run(async (tx) => {
          const result = await fn(tx);
          entered.release();
          await release.promise;
          return result;
        }, options),
    };
    const first = Promise.allSettled([
      h.side(clients[0]!, runner).tenant.restoreStore(w.ctx, { storeId: archived.id }),
    ]);
    let second: ReturnType<typeof Promise.allSettled> | undefined;
    try {
      await bounded(entered.promise);
      second = Promise.allSettled([h.create(w, BODY, h.side(clients[1]!).tenant)]);
      await blocked(observer, pids[1]!, pids[0]!);
      release.release();
      expect((await bounded(first))[0]?.status).toBe("fulfilled");
      expect(error((await bounded(second))[0]!)).toBe("STORE_LIMIT_REACHED");
      expect(
        await h.prisma.store.count({ where: { entityId: w.entityId, lifecycle: "active" } }),
      ).toBe(2);
    } finally {
      release.release();
      await first;
      if (second) await second;
      await observer.end();
    }
  });

  it.each(["idle", "absolute"] as const)(
    "等待完整130图时%s恰好到期，模型外检后也不得写新店",
    async (kind) => {
      const w = await h.owner(),
        start = h.clock.now();
      const source = await h.make.store({ entityId: w.entityId });
      const session = await h.prisma.userSession.findUniqueOrThrow({
        where: { id: w.principal.sessionId },
      });
      const at = kind === "idle" ? session.idleExpiresAt : session.absoluteExpiresAt;
      if (kind === "absolute")
        await h.prisma.userSession.update({
          where: { id: session.id },
          data: { idleExpiresAt: new Date(at.getTime() + 1) },
        });
      const input = { ...BODY, copyFromStoreId: source.id, copyOptions: ["basic"] as ["basic"] };
      const before = await h.state(),
        count = h.validated.mock.calls.length;
      try {
        const result = await held(
          async (tx) => {
            await lockRows(tx, "store", [source.id]);
          },
          () => h.create(w, input, h.side(clients[1]!).tenant),
          () => h.clock.set(at),
        );
        expect(error(result)).toBe("SESSION_INVALID");
        expect(h.validated).toHaveBeenCalledTimes(count + 1);
        expect(await h.state()).toEqual(before);
      } finally {
        h.clock.set(start);
      }
    },
  );

  it.each(["quota", "member", "source"] as const)(
    "%s winner在实际业务锁提交后新命令严格重读",
    async (kind) => {
      const w = await h.owner(),
        source = await h.make.store({ entityId: w.entityId });
      const input = { ...BODY, copyFromStoreId: source.id, copyOptions: ["basic"] as ["basic"] };
      const result = await held(
        async (tx) => {
          if (kind === "quota") {
            await lockRows(tx, "entity", [w.entityId]);
            await tx.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 2 } });
          } else if (kind === "member") {
            await lockRows(tx, "entity_member", [w.memberId]);
            await tx.entityMember.update({ where: { id: w.memberId }, data: { role: "clerk" } });
          } else {
            await lockRows(tx, "store", [source.id]);
            await tx.store.update({
              where: { id: source.id },
              data: {
                lifecycle: "archived",
                archiveReason: "draft_deleted",
                archivedAt: h.clock.now(),
                archiveActorType: "merchant",
                archiveActorId: w.userId,
                archiveClient: "weapp",
              },
            });
          }
        },
        () => h.create(w, input, h.side(clients[1]!).tenant),
      );
      expect(error(result)).toBe(
        kind === "quota"
          ? "STORE_LIMIT_REACHED"
          : kind === "member"
            ? "NOT_A_MEMBER"
            : "VALIDATION_FAILED",
      );
      expect(await h.prisma.store.count({ where: { entityId: w.entityId } })).toBe(2);
      expect(await h.prisma.storeProfile.count({ where: { entityId: w.entityId } })).toBe(0);
      expect(
        await h.prisma.statusTransition.count({
          where: { entityId: w.entityId, event: "store.create" },
        }),
      ).toBe(1);
    },
  );

  it("真实归档先提交释放名额，等待100的创建重新计算后成功", async () => {
    const w = await h.owner(),
      old = await h.make.store({ entityId: w.entityId });
    await h.prisma.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 2 } });
    const entered = gate(),
      release = gate(),
      observer = await connectTestDatabase(db.name, { role: null });
    const runner: TxRunner = {
      run: (fn, options) =>
        h.tx.run(async (tx) => {
          const value = await fn(tx);
          entered.release();
          await release.promise;
          return value;
        }, options),
    };
    const first = Promise.allSettled([
      h.side(clients[0]!, runner).tenant.archiveStore(w.ctx, { storeId: old.id }),
    ]);
    let second: ReturnType<typeof Promise.allSettled> | undefined;
    try {
      await bounded(entered.promise);
      second = Promise.allSettled([h.create(w, BODY, h.side(clients[1]!).tenant)]);
      await blocked(observer, pids[1]!, pids[0]!);
      release.release();
      expect((await bounded(first))[0]?.status).toBe("fulfilled");
      expect((await bounded(second))[0]?.status).toBe("fulfilled");
      expect(
        await h.prisma.store.count({ where: { entityId: w.entityId, lifecycle: "active" } }),
      ).toBe(2);
      expect(await h.prisma.store.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
        lifecycle: "archived",
        archiveReason: "by_owner",
      });
    } finally {
      release.release();
      await first;
      if (second) await second;
      await observer.end();
    }
  });

  it("创建先提交后真实归档不回滚新店，两个事件仅各一次", async () => {
    const w = await h.owner(),
      old = await h.make.store({ entityId: w.entityId });
    await h.prisma.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 3 } });
    const entered = gate(),
      release = gate(),
      observer = await connectTestDatabase(db.name, { role: null });
    const command = h.side(clients[0]!, undefined, {
      initialize: async (...args) => {
        await h.ports.initialize(...args);
        entered.release();
        await release.promise;
      },
    });
    const first = Promise.allSettled([h.create(w, BODY, command.tenant)]);
    let second: ReturnType<typeof Promise.allSettled> | undefined;
    try {
      await bounded(entered.promise);
      second = Promise.allSettled([
        h.side(clients[1]!).tenant.archiveStore(w.ctx, { storeId: old.id }),
      ]);
      await blocked(observer, pids[1]!, pids[0]!);
      release.release();
      expect((await bounded(first))[0]?.status).toBe("fulfilled");
      expect((await bounded(second))[0]?.status).toBe("fulfilled");
      expect(
        await h.prisma.store.count({ where: { entityId: w.entityId, lifecycle: "active" } }),
      ).toBe(2);
      expect(
        await h.prisma.statusTransition.count({
          where: { entityId: w.entityId, event: "store.archive" },
        }),
      ).toBe(1);
      expect(await h.prisma.storeProfile.count({ where: { entityId: w.entityId } })).toBe(1);
    } finally {
      release.release();
      await first;
      if (second) await second;
      await observer.end();
    }
  });
});
