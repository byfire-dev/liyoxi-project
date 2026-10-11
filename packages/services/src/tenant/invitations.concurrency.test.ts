import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTxRunner, isAppError, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { connectTestDatabase, useSeededDatabase } from "../testing/index.js";
import { runTimer } from "../timers/index.js";
import { barrier } from "./__fixtures__/member-removal.js";
import {
  invitationHarness,
  invitationServices,
  memberContext,
  SLOW,
} from "./__fixtures__/invitations.js";
import type { InvitationHarness } from "./__fixtures__/invitations.js";

const db = useSeededDatabase("services");
let h: InvitationHarness;
let clients: PrismaClient[], sides: ReturnType<typeof invitationServices>[], pids: number[];
beforeAll(async () => {
  h = invitationHarness(await db.prisma());
  clients = await Promise.all(
    [0, 1].map(async () => createPrismaClient({ connectionString: await db.url(), max: 1 })),
  );
  sides = clients.map((client) => invitationServices(client, h.clock));
  pids = await Promise.all(
    clients.map(async (client) => {
      const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (!row) throw new Error("业务连接没有 PID");
      return row.pid;
    }),
  );
  expect(pids[0]).not.toBe(pids[1]);
}, SLOW);
afterAll(async () => {
  await Promise.all(clients?.map((client) => client.$disconnect()) ?? []);
}, SLOW);
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function blocked(
  observer: Awaited<ReturnType<typeof connectTestDatabase>>,
  waiter: number,
  holder: number,
) {
  const deadline = Date.now() + 2_000;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked",
      [waiter, holder],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < deadline);
  throw new Error("没有观察到真实业务锁等待");
}
function error(result: PromiseSettledResult<unknown>) {
  if (result.status !== "rejected" || !isAppError(result.reason)) return null;
  return result.reason.error;
}

describe("邀请：两独立业务连接的真实竞争", { timeout: SLOW }, () => {
  it.each(["same", "different"] as const)(
    "%s请求键并发只建一张未分享卡和一份迁移",
    async (mode) => {
      const owner = await h.owner(),
        key = uuidv7(),
        ready = barrier(2);
      const cards = await Promise.all(
        sides.map(async (side, index) => {
          await ready();
          return side.tenant.createInvitation(owner.ctx, {
            clientRequestId: mode === "same" || index === 0 ? key : uuidv7(),
          });
        }),
      );
      expect(cards[0]!.invitationId).toBe(cards[1]!.invitationId);
      expect(cards[0]!.token).toBe(cards[1]!.token);
      const trace = await h.trace(cards[0]!.invitationId);
      expect(trace.requests).toHaveLength(mode === "same" ? 1 : 2);
      expect(trace.history).toHaveLength(1);
      expect(trace.events).toHaveLength(1);
      expect(trace.audits).toHaveLength(1);
      expect(trace.timers.filter((timer) => timer.status === "scheduled")).toHaveLength(1);
      expect(cards.filter((card) => !card.isReused)).toHaveLength(mode === "same" ? 2 : 1);
    },
  );

  it("create与revoke竞争不复活终态，也不丢失新请求永久绑定", async () => {
    const owner = await h.owner(),
      card = await h.card(owner),
      ready = barrier(2),
      key = uuidv7();
    const result = await Promise.allSettled([
      (async () => {
        await ready();
        return sides[0]!.tenant.createInvitation(owner.ctx, { clientRequestId: key });
      })(),
      (async () => {
        await ready();
        return sides[1]!.tenant.revokeInvitation(owner.ctx, {
          invitationId: card.invitationId,
          reason: "by_owner",
        });
      })(),
    ]);
    expect(result.every((item) => item.status === "fulfilled")).toBe(true);
    const created = result[0];
    if (created?.status !== "fulfilled") throw new Error("创建必须提交");
    const old = await h.trace(card.invitationId);
    expect(old.row.status).toBe("revoked");
    expect(old.row.tokenEnc).toBeNull();
    expect(old.history).toHaveLength(2);
    expect(old.events).toHaveLength(2);
    const binding = await h.prisma.invitationRequest.findUniqueOrThrow({
      where: {
        inviterMemberId_clientRequestId: { inviterMemberId: owner.memberId, clientRequestId: key },
      },
    });
    expect(binding.invitationId).toBe(created.value.invitationId);
    if (binding.invitationId === card.invitationId)
      await expect(h.card(owner, { clientRequestId: key })).rejects.toMatchObject({
        error: "STATE_NOT_ALLOWED",
      });
    else expect((await h.card(owner, { clientRequestId: key })).token).toBe(created.value.token);
  });

  it("revoke与expire仅一个真实pending迁移获胜，另一方不覆盖终态", async () => {
    const owner = await h.owner(),
      card = await h.card(owner);
    h.clock.set(new Date(card.expiresAt));
    const ref = await h.claim(card.invitationId),
      ready = barrier(2);
    const result = await Promise.allSettled([
      (async () => {
        await ready();
        return sides[0]!.tenant.revokeInvitation(owner.ctx, {
          invitationId: card.invitationId,
          reason: "by_owner",
        });
      })(),
      (async () => {
        await ready();
        return runTimer(sides[1]!.timerDeps, ref);
      })(),
    ]);
    const trace = await h.trace(card.invitationId);
    expect(["revoked", "expired"]).toContain(trace.row.status);
    expect(trace.row.tokenEnc).toBeNull();
    expect(trace.history).toHaveLength(2);
    expect(trace.events).toHaveLength(2);
    expect(trace.audits).toHaveLength(2);
    if (trace.row.status === "expired") expect(error(result[0]!)).toBe("STATE_NOT_ALLOWED");
    else expect(result[0]?.status).toBe("fulfilled");
  });

  it.each([false, true])(
    "cancel→arm持锁交错 rollback=%s：旧任务fresh判断，不覆盖新scheduled",
    async (rollback) => {
      const owner = await h.owner(),
        first = await h.card(owner);
      const oldRef = await h.claim(first.invitationId);
      const oldExpiry = new Date(first.expiresAt),
        entered = latch(),
        release = latch();
      h.clock.advance(1_000);
      const realRunner = createTxRunner({ prisma: clients[0]!, appEnv: "test" });
      let phase = 0;
      const runner: TxRunner = {
        run: (fn, options) =>
          realRunner.run(async (tx) => {
            const result = await fn(tx);
            if (++phase === 2) {
              const timers = await tx.timer.findMany({ where: { subjectId: first.invitationId } });
              expect(timers.find((timer) => timer.id === oldRef.timerId)?.status).toBe("cancelled");
              expect(timers.filter((timer) => timer.status === "scheduled")).toHaveLength(1);
              entered.release();
              await release.promise;
              if (rollback) throw new Error("复用事务回滚");
            }
            return result;
          }, options),
      };
      const reuse = invitationServices(clients[0]!, h.clock, runner);
      const observer = await connectTestDatabase(db.name, { role: null });
      let oldRun: Promise<unknown> | undefined;
      const creating = reuse.tenant.createInvitation(owner.ctx, { clientRequestId: uuidv7() });
      // 先注册拒绝捕获，finally 必须等待两条真实业务连接收尾。
      const created = Promise.allSettled([creating]);
      try {
        await entered.promise;
        h.clock.set(oldExpiry);
        oldRun = runTimer(sides[1]!.timerDeps, oldRef);
        await blocked(observer, pids[1]!, pids[0]!);
        release.release();
        const [outcome, settled] = await Promise.all([oldRun, created]);
        const trace = await h.trace(first.invitationId);
        if (rollback) {
          expect(settled[0]?.status).toBe("rejected");
          expect(outcome).toBe("fired");
          expect(trace.row.status).toBe("expired");
          expect(trace.requests).toHaveLength(1);
          expect(trace.timers).toHaveLength(1);
          expect(trace.history).toHaveLength(2);
        } else {
          expect(settled[0]?.status).toBe("fulfilled");
          expect(outcome).toBe("stale");
          expect(trace.row.status).toBe("pending");
          expect(trace.row.expiresAt.getTime()).toBe(oldExpiry.getTime() + 1_000);
          expect(trace.requests).toHaveLength(2);
          expect(trace.timers.filter((timer) => timer.status === "scheduled")).toHaveLength(1);
          expect(trace.timers.find((timer) => timer.id === oldRef.timerId)?.status).toBe(
            "cancelled",
          );
          expect(trace.history).toHaveLength(1);
          expect(trace.events).toHaveLength(1);
        }
      } finally {
        release.release();
        await Promise.allSettled([created, ...(oldRun ? [oldRun] : [])]);
        await observer.end();
      }
    },
  );

  it("merchant_user80等待后必须重读disabled账号，不能拿旧owner权限创建", async () => {
    const owner = await h.owner(),
      before = await h.state();
    const holder = await connectTestDatabase(db.name),
      observer = await connectTestDatabase(db.name, { role: null });
    let operation: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      const own = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await holder.query("UPDATE merchant_user SET status='disabled' WHERE id=$1", [owner.userId]);
      operation = sides[0]!.tenant.createInvitation(owner.ctx, { clientRequestId: uuidv7() });
      const settled = Promise.allSettled([operation]);
      await blocked(observer, pids[0]!, own.rows[0]!.pid);
      await holder.query("COMMIT");
      expect(error((await settled)[0]!)).toBe("NOT_A_MEMBER");
      expect(await h.state()).toEqual(before);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled(operation ? [operation] : []);
      await holder.end();
      await observer.end();
    }
  });

  it("share与reuse竞争依据锁后事实选卡，永久映射不漂移", async () => {
    const owner = await h.owner(),
      first = await h.card(owner),
      key = uuidv7(),
      ready = barrier(2);
    const [card, shared] = await Promise.all([
      (async () => {
        await ready();
        return sides[0]!.tenant.createInvitation(owner.ctx, { clientRequestId: key });
      })(),
      (async () => {
        await ready();
        return sides[1]!.tenant.markInvitationShared(owner.ctx, {
          invitationId: first.invitationId,
        });
      })(),
    ]);
    expect(shared.sharedAt).not.toBeNull();
    expect((await h.card(owner, { clientRequestId: key })).token).toBe(card.token);
    const trace = await h.trace(card.invitationId);
    expect(trace.requests.some((request) => request.clientRequestId === key)).toBe(true);
    expect(trace.history).toHaveLength(1);
    expect(trace.events).toHaveLength(1);
    expect(trace.row.sharedAt !== null).toBe(card.invitationId === first.invitationId);
  });

  it("双expiry同一dispatch只一份到期历史/审计/事件", async () => {
    const owner = await h.owner(),
      card = await h.card(owner);
    h.clock.set(new Date(card.expiresAt));
    const ref = await h.claim(card.invitationId),
      ready = barrier(2);
    const result = await Promise.all(
      sides.map(async (side) => {
        await ready();
        return runTimer(side.timerDeps, ref);
      }),
    );
    expect(result).toContain("fired");
    expect(result.every((value) => ["fired", "skipped", "stale"].includes(value))).toBe(true);
    const trace = await h.trace(card.invitationId);
    expect(trace.row.status).toBe("expired");
    expect(trace.history).toHaveLength(2);
    expect(trace.events).toHaveLength(2);
    expect(trace.audits).toHaveLength(2);
  });

  it.each(["seat", "daily"] as const)("跨店新卡竞争%s最后额度，失败者不占绑定", async (mode) => {
    const owner = await h.owner(),
      second = await h.make.store({ entityId: owner.entityId });
    await h.prisma.entity.update({
      where: { id: owner.entityId },
      data: { memberLimitOverride: mode === "seat" ? 1 : 50 },
    });
    if (mode === "daily") await h.param("invitation.daily_cap", 1);
    const ready = barrier(2),
      ids = [owner.storeId, second.id];
    const results = await Promise.allSettled(
      sides.map(async (side, index) => {
        await ready();
        return side.tenant.createInvitation(
          memberContext(owner.userId, owner.entityId, ids[index]!),
          { clientRequestId: uuidv7() },
        );
      }),
    );
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(error(results.find((item) => item.status === "rejected")!)).toBe(
      mode === "seat" ? "SEAT_LIMIT_REACHED" : "INVITATION_DAILY_LIMIT",
    );
    expect(await h.prisma.invitation.count({ where: { entityId: owner.entityId } })).toBe(1);
    expect(await h.prisma.invitationRequest.count({ where: { entityId: owner.entityId } })).toBe(1);
    if (mode === "daily") await h.param("invitation.daily_cap", 20);
  });

  it.each(["entity", "member"] as const)(
    "%s锁等待后重读合法门店停用，拒绝旧active快照",
    async (layer) => {
      const owner = await h.owner(),
        before = await h.state();
      const holder = await connectTestDatabase(db.name),
        observer = await connectTestDatabase(db.name, { role: null });
      let operation: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        const pid = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        if (layer === "entity")
          await holder.query("SELECT id FROM entity WHERE id=$1 FOR UPDATE", [owner.entityId]);
        else
          await holder.query("SELECT id FROM entity_member WHERE id=$1 FOR UPDATE", [
            owner.memberId,
          ]);
        await holder.query(
          "UPDATE store SET lifecycle='archived',archive_reason='by_owner',archived_at=$2,archive_actor_type='merchant',archive_actor_id=$3,archive_client='weapp' WHERE id=$1",
          [owner.storeId, h.clock.now(), owner.userId],
        );
        operation = sides[0]!.tenant.createInvitation(owner.ctx, { clientRequestId: uuidv7() });
        const settled = Promise.allSettled([operation]);
        await blocked(observer, pids[0]!, pid.rows[0]!.pid);
        await holder.query("COMMIT");
        expect(error((await settled)[0]!)).toBe("STORE_ARCHIVED");
        expect(await h.state()).toEqual(before);
      } finally {
        await holder.query("ROLLBACK");
        await Promise.allSettled(operation ? [operation] : []);
        await holder.end();
        await observer.end();
      }
    },
  );
});
