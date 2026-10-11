import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAppError, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { connectTestDatabase, useSeededDatabase } from "../testing/index.js";
import { claimTimers, runTimer } from "../timers/index.js";
import {
  archiveHarness,
  archiveAcceptWorld,
  archiveIdem,
  archiveServices,
  memberContext,
  SLOW,
} from "./__fixtures__/store-archive.js";
import type { ArchiveHarness } from "./__fixtures__/store-archive.js";
import { barrier } from "./__fixtures__/member-removal.js";

const db = useSeededDatabase("services");
let h: ArchiveHarness;
let clients: PrismaClient[];
let sides: ReturnType<typeof archiveServices>[];
let pids: number[];
beforeAll(async () => {
  h = archiveHarness(await db.prisma());
  clients = await Promise.all(
    [0, 1].map(async () => createPrismaClient({ connectionString: await db.url(), max: 1 })),
  );
  sides = clients.map((client) => archiveServices(client, h.clock));
  pids = await Promise.all(
    clients.map(async (client) => {
      const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (!row) throw new Error("缺少真实 backend PID");
      return row.pid;
    }),
  );
  expect(new Set(pids).size).toBe(2);
}, SLOW);
afterAll(async () => {
  await Promise.all(clients?.map((client) => client.$disconnect()) ?? []);
}, SLOW);

async function blocked(
  observer: Awaited<ReturnType<typeof connectTestDatabase>>,
  runner: number,
  holder: number,
) {
  const until = Date.now() + 2_000;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
      [runner, holder],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < until);
  throw new Error("未观察到已知两 backend 的真实锁等待");
}
function errorOf(result: PromiseSettledResult<unknown> | undefined) {
  expect(result?.status).toBe("rejected");
  const error: unknown = result?.status === "rejected" ? result.reason : null;
  expect(isAppError(error)).toBe(true);
  return isAppError(error) ? error.error : null;
}

describe("门店停用：两个真实 app 连接", { timeout: SLOW }, () => {
  it.each([false, true])("同目标并发 sameKey=%s 恰一次迁移", async (sameKey) => {
    const owner = await h.owner();
    await h.clerk(owner);
    const ready = barrier(2),
      key = uuidv7();
    const results = await Promise.allSettled(
      sides.map(async (side) => {
        await ready();
        return side.tenant.archiveStore(
          owner.ctx,
          { storeId: owner.secondId },
          sameKey ? { idem: archiveIdem(owner.ctx, owner.secondId, key) } : {},
        );
      }),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(sameKey ? 2 : 1);
    if (sameKey) expect(results[0]).toEqual(results[1]);
    else expect(errorOf(results.find((r) => r.status === "rejected"))).toBe("STATE_NOT_ALLOWED");
    const trace = await h.trace(owner);
    expect(trace.history.filter((r) => r.event === "store.archive")).toHaveLength(1);
    expect(trace.history.filter((r) => r.event === "entity_member.cascade_remove")).toHaveLength(1);
    expect(trace.events).toHaveLength(2);
    expect(trace.audits).toHaveLength(2);
  });

  it("两家最后启用店竞争，仅一家成功，另一家 fresh 读到 LAST_ACTIVE_STORE", async () => {
    const owner = await h.owner();
    const ready = barrier(2);
    const results = await Promise.allSettled(
      sides.map(async (side, i) => {
        await ready();
        return side.tenant.archiveStore(owner.ctx, { storeId: i ? owner.storeId : owner.secondId });
      }),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // 若另一请求停用了当前店，原中间件边界仍为 STORE_ARCHIVED；都不得再停最后店。
    const code = errorOf(results.find((r) => r.status === "rejected"));
    expect(code).toBe(results[1]?.status === "fulfilled" ? "STORE_ARCHIVED" : "LAST_ACTIVE_STORE");
    expect(
      await h.prisma.store.count({ where: { entityId: owner.entityId, lifecycle: "active" } }),
    ).toBe(1);
    expect((await h.trace(owner)).events).toHaveLength(1);
  });

  it.each(["actor", "member", "scope", "last_store"] as const)(
    "%s 行等待后完整重读，不按锁前快照写入",
    async (mode) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const successor = mode === "member" ? await h.clerk(owner, [owner.storeId]) : null;
      const holder = await connectTestDatabase(db.name);
      const observer = await connectTestDatabase(db.name, { role: null });
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const holderPid = rows[0]!.pid;
        if (mode === "actor") {
          await holder.query("SELECT id FROM merchant_user WHERE id=$1::uuid FOR UPDATE", [
            owner.userId,
          ]);
          await holder.query("UPDATE merchant_user SET status='disabled' WHERE id=$1::uuid", [
            owner.userId,
          ]);
        } else if (mode === "member") {
          await holder.query(
            "SELECT id FROM entity_member WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
            [[owner.memberId, successor!.memberId].sort()],
          );
        } else {
          await holder.query(
            "SELECT id FROM store WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
            [[owner.storeId, owner.secondId].sort()],
          );
        }
        const ctx =
          mode === "last_store"
            ? memberContext(owner.userId, owner.entityId, owner.secondId)
            : owner.ctx;
        pending = sides[0]!.tenant.archiveStore(ctx, { storeId: owner.secondId });
        const settled = Promise.allSettled([pending]);
        await blocked(observer, pids[0]!, holderPid);
        if (mode === "member") {
          // 合法历史让位前提，不声称本片提供 owner transfer producer。
          await holder.query("UPDATE entity_member SET role='clerk' WHERE id=$1::uuid", [
            owner.memberId,
          ]);
          await holder.query("DELETE FROM store_member WHERE entity_member_id=$1::uuid", [
            successor!.memberId,
          ]);
          await holder.query("UPDATE entity_member SET role='owner' WHERE id=$1::uuid", [
            successor!.memberId,
          ]);
          await holder.query(
            "INSERT INTO store_member(entity_member_id,store_id,entity_id,added_by_member_id,created_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5)",
            [owner.memberId, owner.storeId, owner.entityId, successor!.memberId, h.clock.now()],
          );
        }
        if (mode === "scope")
          await holder.query(
            "DELETE FROM store_member WHERE entity_member_id=$1::uuid AND store_id=$2::uuid",
            [clerk.memberId, owner.secondId],
          );
        if (mode === "last_store")
          await holder.query(
            "UPDATE store SET lifecycle='archived',archived_at=$2,archive_actor_type='merchant',archive_actor_id=$3::uuid,archive_client='weapp',archive_reason='by_owner' WHERE id=$1::uuid",
            [owner.storeId, h.clock.now(), owner.userId],
          );
        await holder.query("COMMIT");
        expect(errorOf((await settled)[0])).toBe(
          {
            actor: "NOT_A_MEMBER",
            member: "ROLE_FORBIDDEN",
            scope: "PRECONDITION_CHANGED",
            last_store: "LAST_ACTIVE_STORE",
          }[mode],
        );
        const trace = await h.trace(owner);
        expect(trace.history).toEqual([]);
        expect(trace.events).toEqual([]);
        expect(trace.audits).toEqual([]);
        expect(trace.stores.find((r) => r.id === owner.secondId)?.lifecycle).toBe("active");
      } finally {
        await holder.query("ROLLBACK");
        await pending?.catch(() => undefined);
        await Promise.all([holder.end(), observer.end()]);
      }
    },
  );

  it.each(["create_first", "archive_first"] as const)(
    "%s 与真实邀请 create 串行，归档后无 pending 孤儿",
    async (mode) => {
      const owner = await h.owner();
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runner: TxRunner = {
        run: (fn, options) =>
          sides[0]!.tx.run(async (tx) => {
            const value = await fn(tx);
            enter();
            await gate;
            return value;
          }, options),
      };
      const paused = archiveServices(clients[0]!, h.clock, runner);
      const ctx = memberContext(owner.userId, owner.entityId, owner.secondId);
      const create = (side: ReturnType<typeof archiveServices>) =>
        side.invitations.createInvitation(ctx, { clientRequestId: uuidv7() });
      const first = Promise.allSettled([
        mode === "create_first"
          ? create(paused)
          : paused.tenant.archiveStore(owner.ctx, { storeId: owner.secondId }),
      ]);
      const observer = await connectTestDatabase(db.name, { role: null });
      let second: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await entered;
        second = Promise.allSettled([
          mode === "create_first"
            ? sides[1]!.tenant.archiveStore(owner.ctx, { storeId: owner.secondId })
            : create(sides[1]!),
        ]);
        await blocked(observer, pids[1]!, pids[0]!);
        release();
        expect((await first)[0]?.status).toBe("fulfilled");
        if (mode === "create_first") expect((await second)[0]?.status).toBe("fulfilled");
        else expect(errorOf((await second)[0])).toBe("STORE_ARCHIVED");
        expect(
          await h.prisma.invitation.count({
            where: { storeId: owner.secondId, status: "pending" },
          }),
        ).toBe(0);
        const trace = await h.trace(owner);
        expect(trace.history.filter((r) => r.event === "store.archive")).toHaveLength(1);
        if (mode === "create_first") {
          expect(trace.invitations).toMatchObject([
            { status: "revoked", revokeReason: "store_archived" },
          ]);
          expect(trace.timers).toMatchObject([{ status: "cancelled" }]);
        } else expect(trace.invitations).toEqual([]);
      } finally {
        release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        await observer.end();
      }
    },
  );

  it("先执行归档的连接回滚，等待者仍可真实提交一次", async () => {
    const owner = await h.owner();
    await h.clerk(owner);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = new Error("真实归档 commit 前回滚");
    const runner: TxRunner = {
      run: (fn, options) =>
        sides[0]!.tx.run(async (tx) => {
          await fn(tx);
          enter();
          await gate;
          throw failure;
        }, options),
    };
    const paused = archiveServices(clients[0]!, h.clock, runner);
    const first = Promise.allSettled([
      paused.tenant.archiveStore(owner.ctx, { storeId: owner.secondId }),
    ]);
    const observer = await connectTestDatabase(db.name, { role: null });
    let second: Promise<unknown> | undefined;
    try {
      await entered;
      second = sides[1]!.tenant.archiveStore(owner.ctx, { storeId: owner.secondId });
      await blocked(observer, pids[1]!, pids[0]!);
      release();
      expect((await first)[0]).toMatchObject({ status: "rejected", reason: failure });
      await expect(second).resolves.toMatchObject({ removedMemberCount: 1 });
      const trace = await h.trace(owner);
      expect(trace.history).toHaveLength(2);
      expect(trace.audits).toHaveLength(2);
      expect(trace.events).toHaveLength(2);
    } finally {
      release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      await observer.end();
    }
  });

  it("目标成员/门店 key 小于老板/首店仍按完整升序图锁，不补低锁", async () => {
    const owner = await h.owner();
    const store = await h.make.store({
      id: `00000000-0000-7000-8000-${uuidv7().slice(-12)}`,
      entityId: owner.entityId,
    });
    const user = await h.make.merchantUser();
    const member = await h.make.entityMember({
      id: `00000000-0000-7000-8000-${uuidv7().slice(-12)}`,
      entityId: owner.entityId,
      merchantUserId: user.id,
      invitedByMemberId: owner.memberId,
    });
    await h.make.storeMember({
      entityMemberId: member.id,
      storeId: store.id,
      addedByMemberId: owner.memberId,
    });
    expect(store.id < owner.storeId).toBe(true);
    expect(member.id < owner.memberId).toBe(true);
    await expect(
      sides[0]!.tenant.archiveStore(owner.ctx, { storeId: store.id }),
    ).resolves.toMatchObject({ removedMemberCount: 1 });
    expect(
      (await h.prisma.entityMember.findUniqueOrThrow({ where: { id: member.id } })).status,
    ).toBe("removed");
  });

  it.each(["expire_first", "archive_first"] as const)(
    "%s 与真实 dispatched expiry 两序竞争，旧 finish 不覆写取消",
    async (mode) => {
      const owner = await h.owner(),
        card = await h.card(owner);
      h.clock.set(new Date(card.expiresAt));
      const timer = await h.prisma.timer.findFirstOrThrow({
        where: { subjectId: card.invitationId },
      });
      const batch = await sides[0]!.tx.run((tx) =>
        claimTimers(tx, sides[0]!.timers.registry, h.clock.now()),
      );
      const ref = batch.claimed.find((row) => row.timerId === timer.id);
      if (!ref) throw new Error("本卡真实到期 timer 未认领");
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runner: TxRunner = {
        run: (fn, options) =>
          sides[0]!.tx.run(async (tx) => {
            const value = await fn(tx);
            enter();
            await gate;
            return value;
          }, options),
      };
      const paused = archiveServices(clients[0]!, h.clock, runner);
      const first = Promise.allSettled([
        mode === "expire_first"
          ? runTimer(paused.timerDeps, ref)
          : paused.tenant.archiveStore(owner.ctx, { storeId: owner.secondId }),
      ]);
      const observer = await connectTestDatabase(db.name, { role: null });
      let second: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await entered;
        second = Promise.allSettled([
          mode === "expire_first"
            ? sides[1]!.tenant.archiveStore(owner.ctx, { storeId: owner.secondId })
            : runTimer(sides[1]!.timerDeps, ref),
        ]);
        await blocked(observer, pids[1]!, pids[0]!);
        release();
        const a = (await first)[0],
          b = (await second)[0];
        expect(a?.status).toBe("fulfilled");
        expect(b?.status).toBe("fulfilled");
        if (mode === "expire_first") {
          expect(a).toMatchObject({ value: "fired" });
          expect(b).toMatchObject({ value: { revokedInvitationCount: 0 } });
        } else {
          expect(a).toMatchObject({ value: { revokedInvitationCount: 1 } });
          // 已过 dispatched 预检的旧 handler 等主体锁后返回 skipped，finish 影响零行。
          expect(b).toMatchObject({ value: "skipped" });
        }
        expect(
          await h.prisma.invitation.findUniqueOrThrow({ where: { id: card.invitationId } }),
        ).toMatchObject({
          status: mode === "expire_first" ? "expired" : "revoked",
          tokenEnc: null,
        });
        expect(await h.prisma.timer.findUniqueOrThrow({ where: { id: timer.id } })).toMatchObject({
          status: mode === "expire_first" ? "fired" : "cancelled",
        });
        expect(await runTimer(sides[1]!.timerDeps, ref)).toBe("stale");
        const history = await h.prisma.statusTransition.findMany({
          where: { subjectId: card.invitationId },
        });
        expect(history.filter((r) => r.toState !== "pending")).toHaveLength(1);
      } finally {
        release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        await observer.end();
      }
    },
  );
});

describe("门店停用与已验收的真实接受邀请", { timeout: SLOW }, () => {
  it.each(["archive_first", "accept_first"] as const)(
    "%s 两业务连接按主体锁串行，真实提交后重验并保持唯一终态",
    async (mode) => {
      const world = await archiveAcceptWorld(h.prisma),
        owner = await world.owner(),
        person = await world.person();
      const target = await world.make.store({ entityId: owner.entityId });
      const card = await world.card({
        ...owner,
        storeId: target.id,
        ctx: memberContext(owner.userId, owner.entityId, target.id),
      });
      const before = await Promise.all([
        h.prisma.statusTransition.count({ where: { entityId: owner.entityId } }),
        h.prisma.auditLog.count({ where: { entityId: owner.entityId } }),
        h.prisma.outboxEvent.count({ where: { entityId: owner.entityId } }),
      ]);
      // 门闩在真实 TxRunner 回调尾、真实 commit 前；接受的第二段才持完整业务锁。
      function paused(index: number, phase: number) {
        let enter!: () => void,
          release!: () => void,
          count = 0;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const real = world.archiveSide(clients[index]!).tx;
        const runner: TxRunner = {
          run: (fn, options) =>
            real.run(async (tx) => {
              const result = await fn(tx);
              if (++count === phase) {
                enter();
                await gate;
              }
              return result;
            }, options),
        };
        return { runner, entered, release };
      }
      const firstGate = paused(0, mode === "archive_first" ? 1 : 2),
        secondGate = paused(1, 1),
        observer = await connectTestDatabase(db.name, { role: null });
      const first = Promise.allSettled([
        mode === "archive_first"
          ? world.archiveSide(clients[0]!, firstGate.runner).tenant.archiveStore(owner.ctx, {
              storeId: target.id,
            })
          : world.accept(person, card, {}, world.side(clients[0]!, firstGate.runner)),
      ]);
      let second: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await firstGate.entered;
        // 另一连接仍见原 pending/active，证明不是提交后才发起第二个请求。
        expect(
          await h.prisma.invitation.findUniqueOrThrow({ where: { id: card.invitationId } }),
        ).toMatchObject({ status: "pending", acceptedMemberId: null });
        expect(await h.prisma.store.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
          lifecycle: "active",
        });
        second = Promise.allSettled([
          mode === "archive_first"
            ? world.accept(person, card, {}, world.side(clients[1]!))
            : world.archiveSide(clients[1]!, secondGate.runner).tenant.archiveStore(owner.ctx, {
                storeId: target.id,
              }),
        ]);
        await blocked(observer, pids[1]!, pids[0]!);
        firstGate.release();
        if (mode === "accept_first") {
          // 归档迁移仍未提交时让接受完成其真实当前成员投影，避免把提交后失权当初次失败。
          await secondGate.entered;
          expect((await first)[0]).toMatchObject({
            status: "fulfilled",
            value: { entityId: owner.entityId, storeId: target.id, role: "clerk", isNew: true },
          });
          secondGate.release();
          expect((await second)[0]).toMatchObject({
            status: "fulfilled",
            value: { revokedInvitationCount: 0, removedMemberCount: 1 },
          });
        } else {
          expect((await first)[0]).toMatchObject({
            status: "fulfilled",
            value: { revokedInvitationCount: 1, removedMemberCount: 0 },
          });
          expect(errorOf((await second)[0])).toBe("INVITATION_REVOKED");
        }
        const invitation = await h.prisma.invitation.findUniqueOrThrow({
          where: { id: card.invitationId },
        });
        expect(invitation).toMatchObject({
          status: mode === "accept_first" ? "accepted" : "revoked",
          tokenEnc: null,
          acceptedByUserId: mode === "accept_first" ? person.userId : null,
          revokeReason: mode === "archive_first" ? "store_archived" : null,
        });
        expect(
          await h.prisma.timer.findFirstOrThrow({ where: { subjectId: card.invitationId } }),
        ).toMatchObject({ status: "cancelled" });
        expect(await h.prisma.store.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
          lifecycle: "archived",
          archiveReason: "by_owner",
        });
        expect(
          await h.prisma.entityMember.findMany({ where: { merchantUserId: person.userId } }),
        ).toMatchObject(
          mode === "accept_first"
            ? [
                {
                  id: invitation.acceptedMemberId,
                  status: "removed",
                  lastStoreId: null,
                  removeReason: "store_archived",
                },
              ]
            : [],
        );
        expect(await h.prisma.storeMember.count({ where: { storeId: target.id } })).toBe(0);
        expect(
          await h.prisma.entityMember.count({
            where: { merchantUserId: person.userId, status: "active" },
          }),
        ).toBe(0);
        const history = await h.prisma.statusTransition.findMany({
          where: { entityId: owner.entityId },
        });
        expect(history.filter((row) => row.event === "store.archive")).toHaveLength(1);
        expect(history.filter((row) => row.event === "invitation.accept")).toHaveLength(
          mode === "accept_first" ? 1 : 0,
        );
        expect(history.filter((row) => row.event === "invitation.revoke")).toHaveLength(
          mode === "archive_first" ? 1 : 0,
        );
        expect(history.filter((row) => row.event === "entity_member.join")).toHaveLength(
          mode === "accept_first" ? 1 : 0,
        );
        expect(history.filter((row) => row.event === "entity_member.cascade_remove")).toHaveLength(
          mode === "accept_first" ? 1 : 0,
        );
        const events = await h.prisma.outboxEvent.findMany({ where: { entityId: owner.entityId } });
        const delta = mode === "accept_first" ? 4 : 2;
        expect(history).toHaveLength(before[0]! + delta);
        expect(await h.prisma.auditLog.count({ where: { entityId: owner.entityId } })).toBe(
          before[1]! + delta,
        );
        expect(events).toHaveLength(before[2]! + delta);
        expect(
          await h.prisma.invitationRequest.count({ where: { invitationId: card.invitationId } }),
        ).toBe(1);
        expect(events.filter((row) => row.eventType === "store.archived")).toHaveLength(1);
        expect(events.filter((row) => row.eventType === "invitation.accepted")).toHaveLength(
          mode === "accept_first" ? 1 : 0,
        );
        expect(events.filter((row) => row.eventType === "invitation.revoked")).toHaveLength(
          mode === "archive_first" ? 1 : 0,
        );
        expect(events.filter((row) => row.eventType === "entity_member.removed")).toHaveLength(
          mode === "accept_first" ? 1 : 0,
        );
        await expect(world.accept(person, card, {}, world.side(clients[1]!))).rejects.toMatchObject(
          {
            error: mode === "accept_first" ? "STORE_ARCHIVED" : "INVITATION_REVOKED",
          },
        );
        // 真登录会话仍有效，归档只改变门店/成员权限。
        expect((await world.identity.authenticate(person.token, { ip: "203.0.113.28" })).ok).toBe(
          true,
        );
      } finally {
        firstGate.release();
        secondGate.release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        await observer.end();
      }
    },
  );
});
