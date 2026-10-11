import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isAppError, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { connectTestDatabase, useSeededDatabase } from "../testing/index.js";
import {
  barrier,
  removalHarness,
  removalIdem,
  removalServices,
  SLOW,
} from "./__fixtures__/member-removal.js";
import type { RemovalHarness } from "./__fixtures__/member-removal.js";

const db = useSeededDatabase("services");
let h: RemovalHarness;
let clients: [PrismaClient, PrismaClient];
let sides: [ReturnType<typeof removalServices>, ReturnType<typeof removalServices>];
let runnerPids: [number, number];

beforeAll(async () => {
  h = removalHarness(await db.prisma());
  clients = (await Promise.all(
    [0, 1].map(async () =>
      createPrismaClient({
        connectionString: await db.url(),
        max: 1,
      }),
    ),
  )) as [PrismaClient, PrismaClient];
  sides = [removalServices(clients[0], h.clock), removalServices(clients[1], h.clock)];
  const pids = await Promise.all(
    clients.map(async (client) => {
      const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (!row) throw new Error("missing runner backend");
      return row.pid;
    }),
  );
  runnerPids = [pids[0]!, pids[1]!];
  expect(runnerPids[0]).not.toBe(runnerPids[1]);
}, SLOW);

afterAll(async () => {
  await Promise.all(clients?.map((client) => client.$disconnect()) ?? []);
}, SLOW);

function rejection(result: PromiseSettledResult<unknown>) {
  expect(result.status).toBe("rejected");
  const error: unknown = result.status === "rejected" ? result.reason : null;
  expect(isAppError(error)).toBe(true);
  return isAppError(error) ? error.error : null;
}

async function oneRemoval(memberId: string) {
  const trace = await h.trace(memberId);
  expect(trace.member.status).toBe("removed");
  expect(trace.member.lastStoreId).toBeNull();
  expect(trace.stores).toEqual([]);
  expect(trace.history).toHaveLength(1);
  expect(trace.audits).toHaveLength(1);
  expect(trace.events).toHaveLength(1);
  return trace;
}

// 业务 holder 用默认 app 身份；owner 连接只读取 pg_stat_activity/阻塞事实。
// 只查已知两个 PID，短暂轮询直到真实锁等待，不把时间延迟当成阻塞证据。
async function waitBlocked(
  observer: Awaited<ReturnType<typeof connectTestDatabase>>,
  runnerPid: number,
  blockerPid: number,
) {
  const deadline = Date.now() + 2_000;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked",
      [runnerPid, blockerPid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < deadline);
  throw new Error("runner did not wait on the known holder");
}

describe("成员移除：两独立连接", () => {
  it(
    "老板同目标两次 remove 恰一成功，失败者不覆写原因/时间",
    async () => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const ready = barrier(2);
      const results = await Promise.allSettled(
        sides.map(async (side) => {
          await ready();
          return side.tenant.removeMember(owner.ctx, { memberId: clerk.memberId });
        }),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((result) => result.status === "rejected");
      expect(lost).toBeDefined();
      expect(rejection(lost!)).toBe("STATE_NOT_ALLOWED");
      const trace = await oneRemoval(clerk.memberId);
      expect(trace.member.removeReason).toBe("by_owner");
      expect(trace.history[0]?.event).toBe("entity_member.remove");
    },
    SLOW,
  );

  it(
    "老板 remove 与本人 leave 竞争，仅赢家对应原因/事件提交",
    async () => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const ready = barrier(2);
      const results = await Promise.allSettled([
        (async () => {
          await ready();
          return sides[0].tenant.removeMember(owner.ctx, { memberId: clerk.memberId });
        })(),
        (async () => {
          await ready();
          return sides[1].tenant.leaveMembership(clerk.ctx);
        })(),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const trace = await oneRemoval(clerk.memberId);
      if (results[0]?.status === "fulfilled") {
        expect(rejection(results[1]!)).toBe("NOT_A_MEMBER");
        expect(trace.member).toMatchObject({
          removeReason: "by_owner",
          removeActorId: owner.userId,
        });
        expect(trace.history[0]?.event).toBe("entity_member.remove");
      } else {
        expect(rejection(results[0]!)).toBe("STATE_NOT_ALLOWED");
        expect(trace.member).toMatchObject({ removeReason: "self", removeActorId: clerk.userId });
        expect(trace.history[0]?.event).toBe("entity_member.leave");
      }
      expect(trace.events[0]?.payload).toMatchObject({ removeReason: trace.member.removeReason });
    },
    SLOW,
  );

  it.each(["remove", "leave"] as const)(
    "%s 同键并发都返回首次结果，仅一组副作用",
    async (mode) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const ctx = mode === "remove" ? owner.ctx : clerk.ctx;
      const key = uuidv7();
      const ready = barrier(2);
      const tokens = sides.map(() => removalIdem(ctx, { mode, key, memberId: clerk.memberId }));
      const results = await Promise.all(
        sides.map(async (side, index) => {
          await ready();
          return mode === "remove"
            ? side.tenant.removeMember(ctx, { memberId: clerk.memberId }, { idem: tokens[index]! })
            : side.tenant.leaveMembership(ctx, { idem: tokens[index]! });
        }),
      );
      expect(results[0]).toEqual(results[1]);
      expect(tokens.map((token) => token.replayed).sort()).toEqual([false, true]);
      await oneRemoval(clerk.memberId);
      expect(
        await h.prisma.idempotencyRecord.count({ where: { key, scope: tokens[0]!.scope } }),
      ).toBe(1);
    },
    SLOW,
  );

  it(
    "同老板移除两个不同店员均成功，共享 actor 锁没有重复或交叉写",
    async () => {
      const owner = await h.owner();
      const clerks = await Promise.all([h.clerk(owner), h.clerk(owner)]);
      const beforeOwner = await h.trace(owner.memberId);
      const ready = barrier(2);
      const results = await Promise.all(
        sides.map(async (side, index) => {
          await ready();
          return side.tenant.removeMember(owner.ctx, { memberId: clerks[index]!.memberId });
        }),
      );
      expect(results.map((result) => result.memberId).sort()).toEqual(
        clerks.map((clerk) => clerk.memberId).sort(),
      );
      for (const clerk of clerks) await oneRemoval(clerk.memberId);
      expect(await h.trace(owner.memberId)).toEqual(beforeOwner);
    },
    SLOW,
  );

  it(
    "目标 key 小于 actor 时仍按 entity100→所有 member120 升序锁",
    async () => {
      const owner = await h.owner();
      const user = await h.make.merchantUser();
      const member = await h.make.entityMember({
        id: `00000000-0000-4000-8000-${uuidv7().slice(-12)}`,
        entityId: owner.entityId,
        merchantUserId: user.id,
        role: "clerk",
        lastStoreId: owner.storeId,
      });
      await h.make.storeMember({
        entityMemberId: member.id,
        storeId: owner.storeId,
        addedByMemberId: owner.memberId,
      });
      expect(member.id < owner.memberId).toBe(true);
      expect(await sides[0].tenant.removeMember(owner.ctx, { memberId: member.id })).toMatchObject({
        status: "removed",
      });
      await oneRemoval(member.id);
    },
    SLOW,
  );

  it(
    "真实主体行锁阻塞 remove；另一连接已移除后重读终态而非覆盖",
    async () => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const holder = await connectTestDatabase(db.name);
      const observer = await connectTestDatabase(db.name, { role: null });
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await holder.query("SELECT id FROM entity WHERE id=$1::uuid FOR UPDATE", [owner.entityId]);
        // 模拟另一个已完成的合法成员终态；这里只证明锁后重读，不声称调用了它的 producer。
        await holder.query(
          "UPDATE entity_member SET status='removed', removed_at=$2, remove_reason='self', remove_actor_type='merchant', remove_actor_id=merchant_user_id, remove_client='weapp', last_store_id=NULL, updated_at=$2 WHERE id=$1::uuid",
          [clerk.memberId, h.clock.now()],
        );
        await holder.query("DELETE FROM store_member WHERE entity_member_id=$1::uuid", [
          clerk.memberId,
        ]);
        pending = sides[0].tenant.removeMember(owner.ctx, { memberId: clerk.memberId });
        void pending.catch(() => undefined);
        await waitBlocked(observer, runnerPids[0], rows[0]!.pid);
        await holder.query("COMMIT");
        await expect(pending).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
        const trace = await h.trace(clerk.memberId);
        expect(trace.member.removeReason).toBe("self");
        expect(trace.history).toEqual([]);
        expect(trace.audits).toEqual([]);
        expect(trace.events).toEqual([]);
      } finally {
        await holder.query("ROLLBACK");
        await pending?.catch(() => undefined);
        await Promise.all([holder.end(), observer.end()]);
      }
    },
    SLOW,
  );

  it(
    "真实 actor member 锁等待后老板已让位，旧 owner 快照不能移除",
    async () => {
      const owner = await h.owner();
      const target = await h.clerk(owner);
      const successor = await h.clerk(owner);
      const beforeTarget = await h.trace(target.memberId);
      const holder = await connectTestDatabase(db.name);
      const observer = await connectTestDatabase(db.name, { role: null });
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await holder.query(
          "SELECT id FROM entity_member WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
          [[owner.memberId, successor.memberId].sort()],
        );
        pending = sides[0].tenant.removeMember(owner.ctx, { memberId: target.memberId });
        void pending.catch(() => undefined);
        await waitBlocked(observer, runnerPids[0], rows[0]!.pid);
        // 最终保留恰一 active owner、owner 无 store_member；不冒称本片有后台让位 producer。
        await holder.query("UPDATE entity_member SET role='clerk' WHERE id=$1::uuid", [
          owner.memberId,
        ]);
        await holder.query(
          "INSERT INTO store_member(entity_member_id,store_id,entity_id,added_by_member_id,created_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5)",
          [owner.memberId, owner.storeId, owner.entityId, successor.memberId, h.clock.now()],
        );
        await holder.query("DELETE FROM store_member WHERE entity_member_id=$1::uuid", [
          successor.memberId,
        ]);
        await holder.query("UPDATE entity_member SET role='owner' WHERE id=$1::uuid", [
          successor.memberId,
        ]);
        await holder.query("COMMIT");
        await expect(pending).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
        expect(await h.trace(target.memberId)).toEqual(beforeTarget);
        expect(
          await h.prisma.entityMember.count({
            where: { entityId: owner.entityId, status: "active", role: "owner" },
          }),
        ).toBe(1);
      } finally {
        await holder.query("ROLLBACK");
        await pending?.catch(() => undefined);
        await Promise.all([holder.end(), observer.end()]);
      }
    },
    SLOW,
  );

  it(
    "真实 target member 锁等待后本人已被移除，leave 不重写已有事实",
    async () => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const holder = await connectTestDatabase(db.name);
      const observer = await connectTestDatabase(db.name, { role: null });
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await holder.query("SELECT id FROM entity_member WHERE id=$1::uuid FOR UPDATE", [
          clerk.memberId,
        ]);
        pending = sides[1].tenant.leaveMembership(clerk.ctx);
        void pending.catch(() => undefined);
        await waitBlocked(observer, runnerPids[1], rows[0]!.pid);
        await holder.query(
          "UPDATE entity_member SET status='removed', removed_at=$2, remove_reason='by_owner', remove_actor_type='merchant', remove_actor_id=$3::uuid, remove_client='weapp', last_store_id=NULL, updated_at=$2 WHERE id=$1::uuid",
          [clerk.memberId, h.clock.now(), owner.userId],
        );
        await holder.query("DELETE FROM store_member WHERE entity_member_id=$1::uuid", [
          clerk.memberId,
        ]);
        await holder.query("COMMIT");
        await expect(pending).rejects.toMatchObject({ error: "NOT_A_MEMBER" });
        const trace = await h.trace(clerk.memberId);
        expect(trace.member.removeReason).toBe("by_owner");
        expect(trace.history).toEqual([]);
        expect(trace.audits).toEqual([]);
        expect(trace.events).toEqual([]);
      } finally {
        await holder.query("ROLLBACK");
        await pending?.catch(() => undefined);
        await Promise.all([holder.end(), observer.end()]);
      }
    },
    SLOW,
  );

  it(
    "两连接中失败者事务回滚，未回滚的竞争者随后真实成功",
    async () => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const failure = new Error("first transaction rolls back");
      let completed!: () => void;
      let release!: () => void;
      const completedBody = new Promise<void>((resolve) => (completed = resolve));
      const canFail = new Promise<void>((resolve) => (release = resolve));
      const runner: TxRunner = {
        run: (fn, options) =>
          sides[0].tx.run(async (tx) => {
            const result = await fn(tx);
            expect(result).toMatchObject({ status: "removed" });
            completed();
            await canFail;
            throw failure;
          }, options),
      };
      const failing = removalServices(clients[0], h.clock, runner);
      const observer = await connectTestDatabase(db.name, { role: null });
      const first = failing.tenant.removeMember(owner.ctx, { memberId: clerk.memberId });
      void first.catch(() => undefined);
      let second: Promise<unknown> | undefined;
      try {
        await Promise.race([completedBody, first]);
        second = sides[1].tenant.leaveMembership(clerk.ctx);
        void second.catch(() => undefined);
        await waitBlocked(observer, runnerPids[1], runnerPids[0]);
        release();
        await expect(first).rejects.toBe(failure);
        await expect(second).resolves.toMatchObject({
          memberId: clerk.memberId,
          status: "removed",
        });
      } finally {
        release();
        await first.catch(() => undefined);
        await second?.catch(() => undefined);
        await observer.end();
      }
      const trace = await oneRemoval(clerk.memberId);
      expect(trace.member.removeReason).toBe("self");
      expect(trace.history[0]?.event).toBe("entity_member.leave");
      expect(trace.member.removeActorId).toBe(clerk.userId);
      expect(
        await h.tenant.resolveMembership(h.prisma, {
          merchantUserId: clerk.userId,
          storeId: owner.storeId,
        }),
      ).toBeNull();
    },
    SLOW,
  );
});
