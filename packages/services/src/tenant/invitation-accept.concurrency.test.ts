import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTxRunner, isAppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import { connectTestDatabase, useSeededDatabase } from "../testing/index.js";
import { runTimer } from "../timers/index.js";
import { acceptHarness, memberContext, SLOW } from "./__fixtures__/invitation-accept.js";
import type { AcceptHarness } from "./__fixtures__/invitation-accept.js";
import { barrier } from "./__fixtures__/member-removal.js";

const db = useSeededDatabase("services");
let h: AcceptHarness,
  clients: PrismaClient[],
  sides: ReturnType<AcceptHarness["side"]>[],
  pids: number[];
beforeAll(async () => {
  h = await acceptHarness(await db.prisma());
  clients = await Promise.all(
    [0, 1].map(async () => createPrismaClient({ connectionString: await db.url(), max: 1 })),
  );
  sides = clients.map((client) => h.side(client));
  pids = await Promise.all(
    clients.map(async (client) => {
      const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (!row) throw new Error("真实业务连接没有 PID");
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
function code(result: PromiseSettledResult<unknown> | undefined) {
  return result?.status === "rejected" && isAppError(result.reason) ? result.reason.error : null;
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
  throw new Error("未观察到两条真实业务连接的锁等待");
}
function hold(action: (tx: Tx) => Promise<unknown>) {
  const entered = latch(),
    release = latch();
  const running = createTxRunner({ prisma: clients[0]!, appEnv: "test" }).run(async (tx) => {
    await action(tx);
    entered.release();
    await release.promise;
  });
  const settled = Promise.allSettled([running]);
  return { entered: entered.promise, release: release.release, settled };
}
function pausedSide(phase: number) {
  const entered = latch(),
    release = latch(),
    real = createTxRunner({ prisma: clients[0]!, appEnv: "test" });
  let count = 0;
  const runner: TxRunner = {
    run: (fn, options) =>
      real.run(async (tx) => {
        const result = await fn(tx);
        if (++count === phase) {
          entered.release();
          await release.promise;
        }
        return result;
      }, options),
  };
  return { side: h.side(clients[0]!, runner), entered: entered.promise, release: release.release };
}

describe("接受邀请：两业务连接、完整锁图与 fresh 会话/时钟", { timeout: SLOW }, () => {
  it("两个账号争同邀请只有一个接受人和一份加入/接受副作用", async () => {
    const owner = await h.owner(),
      people = await Promise.all([h.person(), h.person()]),
      card = await h.card(owner),
      ready = barrier(2);
    const results = await Promise.allSettled(
      people.map(async (person, index) => {
        await ready();
        return h.accept(person, card, {}, sides[index]!);
      }),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.map(code).filter(Boolean)).toEqual(["INVITATION_USED"]);
    const trace = await h.trace(card.invitationId);
    expect(trace.row.status).toBe("accepted");
    expect(people.map((person) => person.userId)).toContain(trace.row.acceptedByUserId);
    expect(trace.history.filter((row) => row.event === "invitation.accept")).toHaveLength(1);
    expect(trace.events.filter((row) => row.eventType === "invitation.accepted")).toHaveLength(1);
    expect(
      await h.prisma.entityMember.count({
        where: { merchantUserId: { in: people.map((person) => person.userId) }, status: "active" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.storeMember.count({ where: { entityMemberId: trace.row.acceptedMemberId! } }),
    ).toBe(1);
  });

  it("同账号争两个主体在 merchant_user80 串行，只加入一个主体", async () => {
    const owners = await Promise.all([h.owner(), h.owner()]),
      person = await h.person();
    const cards = await Promise.all(owners.map((owner) => h.card(owner))),
      ready = barrier(2);
    const results = await Promise.allSettled(
      cards.map(async (card, index) => {
        await ready();
        return h.accept(person, card, {}, sides[index]!);
      }),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(code(failure)).toBe("PHONE_IN_OTHER_ENTITY");
    if (failure?.status === "rejected")
      expect(failure.reason).toMatchObject({ details: { currentRole: "clerk" } });
    expect(
      await h.prisma.entityMember.count({
        where: { merchantUserId: person.userId, status: "active" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.invitation.count({
        where: { id: { in: cards.map((card) => card.invitationId) }, status: "accepted" },
      }),
    ).toBe(1);
  });

  it.each(["lower", "higher"] as const)(
    "旧主体 UUID %s：排序 union 后真实让位且无低锁补拿",
    async (order) => {
      const pair = [await h.owner(), await h.owner()].sort((a, b) =>
        a.entityId.localeCompare(b.entityId),
      );
      const old = pair[order === "lower" ? 0 : 1]!,
        target = pair[order === "lower" ? 1 : 0]!;
      const card = await h.card(target),
        result = await h.accept(old, card, {}, sides[0]!);
      expect(result).toMatchObject({
        abandonedEntityId: old.entityId,
        entityId: target.entityId,
        role: "clerk",
      });
      expect(
        (await h.prisma.entity.findUniqueOrThrow({ where: { id: old.entityId } })).lifecycle,
      ).toBe("abandoned");
      expect(
        await h.prisma.entityMember.count({
          where: { merchantUserId: old.userId, status: "active" },
        }),
      ).toBe(1);
    },
  );

  it("createEntity 与 accept 同账号竞争，不出现第二份有效成员", async () => {
    const owner = await h.owner(),
      person = await h.person(),
      card = await h.card(owner),
      ready = barrier(2);
    const results = await Promise.allSettled([
      (async () => {
        await ready();
        return sides[0]!.tenant.createEntity(person.ctx);
      })(),
      (async () => {
        await ready();
        return h.accept(person, card, {}, sides[1]!);
      })(),
    ]);
    expect(results[1]?.status).toBe("fulfilled");
    if (results[0]?.status === "rejected") expect(code(results[0])).toBe("ALREADY_IN_ENTITY");
    else expect(results[0]).toMatchObject({ status: "fulfilled", value: { role: "owner" } });
    expect(
      await h.prisma.entityMember.findMany({
        where: { merchantUserId: person.userId, status: "active" },
      }),
    ).toEqual([expect.objectContaining({ entityId: owner.entityId, role: "clerk" })]);
    expect((await h.trace(card.invitationId)).row.acceptedByUserId).toBe(person.userId);
  });

  it.each(["create", "abandon"] as const)(
    "%s 先持锁：pending 不能被撤销制造空草稿，旧老板不能继续创建",
    async (winner) => {
      const old = await h.owner(),
        target = await h.owner(),
        card = await h.card(target),
        paused = pausedSide(2);
      const observer = await connectTestDatabase(db.name, { role: null });
      const first =
        winner === "create"
          ? paused.side.tenant.createInvitation(
              old.ctx,
              { clientRequestId: uuidv7() },
              { principal: old.principal },
            )
          : h.accept(old, card, {}, paused.side);
      const firstResult = Promise.allSettled([first]);
      let secondResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await paused.entered;
        secondResult = Promise.allSettled([
          winner === "create"
            ? h.accept(old, card, {}, sides[1]!)
            : sides[1]!.tenant.createInvitation(
                old.ctx,
                { clientRequestId: uuidv7() },
                { principal: old.principal },
              ),
        ]);
        await blocked(observer, pids[1]!, pids[0]!);
        paused.release();
        expect((await firstResult)[0]?.status).toBe("fulfilled");
        expect(code((await secondResult)[0])).toBe(
          winner === "create" ? "PHONE_IN_OTHER_ENTITY" : "NOT_A_MEMBER",
        );
        expect(
          await h.prisma.invitation.count({ where: { entityId: old.entityId, status: "pending" } }),
        ).toBe(winner === "create" ? 1 : 0);
        expect(
          (await h.prisma.entity.findUniqueOrThrow({ where: { id: old.entityId } })).lifecycle,
        ).toBe(winner === "create" ? "active" : "abandoned");
        expect((await h.trace(card.invitationId)).row.status).toBe(
          winner === "create" ? "pending" : "accepted",
        );
      } finally {
        paused.release();
        await Promise.allSettled([firstResult, ...(secondResult ? [secondResult] : [])]);
        await observer.end();
      }
    },
  );

  it.each(["deadline", "revoked"] as const)(
    "store130 等待后 fresh %s，不能按等待前事实接受",
    async (change) => {
      const owner = await h.owner(),
        person = await h.person(),
        card = await h.card(owner);
      const holder = hold((tx) => lockRows(tx, "store", [owner.storeId]));
      const observer = await connectTestDatabase(db.name, { role: null });
      let result: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await holder.entered;
        result = Promise.allSettled([h.accept(person, card, {}, sides[1]!)]);
        await blocked(observer, pids[1]!, pids[0]!);
        if (change === "deadline") h.clock.set(new Date(card.expiresAt));
        if (change === "revoked")
          await h.identity.logout(person.principal, {
            requestId: uuidv7(),
            ip: null,
            userAgent: null,
            clientVersion: null,
          });
        holder.release();
        expect((await holder.settled)[0]?.status).toBe("fulfilled");
        const outcome = (await result)[0];
        expect(code(outcome)).toBe(
          change === "deadline" ? "INVITATION_EXPIRED" : "SESSION_INVALID",
        );
        expect((await h.trace(card.invitationId)).row.status).toBe("pending");
        expect(
          await h.prisma.entityMember.count({ where: { merchantUserId: person.userId } }),
        ).toBe(0);
      } finally {
        holder.release();
        await Promise.allSettled([holder.settled, ...(result ? [result] : [])]);
        await observer.end();
      }
    },
  );

  it("merchant80 等待后真实 disabled 账号不能接受，未提交前 claim 仍能读到 active", async () => {
    const owner = await h.owner(),
      person = await h.person(),
      card = await h.card(owner);
    const holder = hold(async (tx) => {
      await lockRows(tx, "merchant_user", [person.userId], "update");
      await tx.merchantUser.update({ where: { id: person.userId }, data: { status: "disabled" } });
    });
    const observer = await connectTestDatabase(db.name, { role: null });
    let result: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await holder.entered;
      expect(
        (await h.prisma.merchantUser.findUniqueOrThrow({ where: { id: person.userId } })).status,
      ).toBe("active");
      result = Promise.allSettled([h.accept(person, card, {}, sides[1]!)]);
      await blocked(observer, pids[1]!, pids[0]!);
      holder.release();
      expect(code((await result)[0])).toBe("SESSION_INVALID");
      expect((await h.trace(card.invitationId)).row.status).toBe("pending");
      expect(await h.prisma.entityMember.count({ where: { merchantUserId: person.userId } })).toBe(
        0,
      );
    } finally {
      holder.release();
      await Promise.allSettled([holder.settled, ...(result ? [result] : [])]);
      await observer.end();
    }
  });

  it("店员被真实移除但事务未提交时接受等待；提交后不复用 removed 成员", async () => {
    const owner = await h.owner(),
      person = await h.clerk(owner),
      store = await h.make.store({ entityId: owner.entityId });
    const card = await h.card({
      ...owner,
      storeId: store.id,
      ctx: memberContext(owner.userId, owner.entityId, store.id),
    });
    const paused = pausedSide(1),
      observer = await connectTestDatabase(db.name, { role: null });
    const removal = Promise.allSettled([
      paused.side.tenant.removeMember(owner.ctx, { memberId: person.memberId }),
    ]);
    let result: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await paused.entered;
      result = Promise.allSettled([h.accept(person, card, {}, sides[1]!)]);
      await blocked(observer, pids[1]!, pids[0]!);
      paused.release();
      expect((await removal)[0]?.status).toBe("fulfilled");
      expect(code((await result)[0])).toBe("PRECONDITION_CHANGED");
      expect(
        (await h.prisma.entityMember.findUniqueOrThrow({ where: { id: person.memberId } })).status,
      ).toBe("removed");
      expect((await h.trace(card.invitationId)).row.status).toBe("pending");
    } finally {
      paused.release();
      await Promise.allSettled([removal, ...(result ? [result] : [])]);
      await observer.end();
    }
  });

  it("归档门店的未提交真实 UPDATE 挡住接受，锁后拒绝并保 pending", async () => {
    const owner = await h.owner(),
      person = await h.person(),
      card = await h.card(owner);
    const holder = hold(async (tx) => {
      await lockRows(tx, "store", [owner.storeId]);
      await tx.store.update({
        where: { id: owner.storeId },
        data: {
          lifecycle: "archived",
          archivedAt: h.clock.now(),
          archiveActorType: "merchant",
          archiveActorId: owner.userId,
          archiveClient: "weapp",
          archiveReason: "by_owner",
        },
      });
    });
    const observer = await connectTestDatabase(db.name, { role: null });
    let result: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await holder.entered;
      result = Promise.allSettled([h.accept(person, card, {}, sides[1]!)]);
      await blocked(observer, pids[1]!, pids[0]!);
      holder.release();
      expect(code((await result)[0])).toBe("INVITATION_REVOKED");
      expect((await h.trace(card.invitationId)).row.status).toBe("pending");
    } finally {
      holder.release();
      await Promise.allSettled([holder.settled, ...(result ? [result] : [])]);
      await observer.end();
    }
  });

  it("expire 与 accept 竞争只一份终态；过期 timer 不覆盖已接受", async () => {
    const owner = await h.owner(),
      person = await h.person(),
      card = await h.card(owner);
    const ref = await h.claim(card.invitationId),
      paused = pausedSide(2);
    const observer = await connectTestDatabase(db.name, { role: null });
    const accepted = Promise.allSettled([h.accept(person, card, {}, paused.side)]);
    let expired: Promise<unknown> | undefined;
    try {
      await paused.entered;
      h.clock.set(new Date(card.expiresAt));
      expired = runTimer(sides[1]!.timerDeps, ref);
      const outcome = Promise.allSettled([expired]);
      await blocked(observer, pids[1]!, pids[0]!);
      paused.release();
      expect((await accepted)[0]?.status).toBe("fulfilled");
      expect((await outcome)[0]).toMatchObject({ status: "fulfilled", value: "stale" });
      const trace = await h.trace(card.invitationId);
      expect(trace.row.status).toBe("accepted");
      expect(trace.history).toHaveLength(2);
      expect(trace.events).toHaveLength(2);
      expect(trace.timers[0]?.status).toBe("cancelled");
    } finally {
      paused.release();
      await Promise.allSettled([accepted, ...(expired ? [expired] : [])]);
      await observer.end();
    }
  });

  it("接受 claim 已完成但 expiry 先提交，settle fresh 拒绝并删除自身技术占用", async () => {
    const owner = await h.owner(),
      person = await h.person(),
      card = await h.card(owner);
    const ref = await h.claim(card.invitationId),
      paused = pausedSide(1);
    const count = await h.prisma.idempotencyRecord.count();
    const result = Promise.allSettled([h.accept(person, card, {}, paused.side)]);
    try {
      await paused.entered;
      h.clock.set(new Date(card.expiresAt));
      expect(await runTimer(sides[1]!.timerDeps, ref)).toBe("fired");
      paused.release();
      expect(code((await result)[0])).toBe("INVITATION_EXPIRED");
      const trace = await h.trace(card.invitationId);
      expect(trace.row.status).toBe("expired");
      expect(trace.row.acceptedMemberId).toBeNull();
      expect(trace.history).toHaveLength(2);
      expect(trace.events.map((event) => event.eventType)).toEqual([
        "invitation.created",
        "invitation.expired",
      ]);
      expect(await h.prisma.entityMember.count({ where: { merchantUserId: person.userId } })).toBe(
        0,
      );
      expect(await h.prisma.idempotencyRecord.count()).toBe(count);
    } finally {
      paused.release();
      await result;
    }
  });
});
