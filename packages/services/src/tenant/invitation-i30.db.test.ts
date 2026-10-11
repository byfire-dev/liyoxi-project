import { createHash } from "node:crypto";
import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTxRunner, lockRows, TX_TIMEOUT_MAX_MS, uuidv7 } from "../kernel/index.js";
import type { InvariantScope, InvariantSubject, TxRunner } from "../kernel/index.js";
import { connectTestDatabase, useSeededDatabase } from "../testing/index.js";
import { runTimer } from "../timers/index.js";
import { createInvitationExpiry } from "./index.js";
import { acceptHarness, SLOW } from "./__fixtures__/invitation-accept.js";
import type { AcceptHarness } from "./__fixtures__/invitation-accept.js";

const HOUR = 3_600_000;
const db = useSeededDatabase("services");
let h: AcceptHarness;
let clients: PrismaClient[], pids: number[];
beforeAll(async () => {
  h = await acceptHarness(await db.prisma());
  clients = await Promise.all(
    [0, 1].map(async () => createPrismaClient({ connectionString: await db.url(), max: 1 })),
  );
  pids = await Promise.all(
    clients.map(async (client) => {
      const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (!row) throw new Error("业务连接缺少PID");
      return row.pid;
    }),
  );
  expect(pids[0]).not.toBe(pids[1]);
}, SLOW);
afterAll(async () => {
  await Promise.all(clients?.map((client) => client.$disconnect()) ?? []);
}, SLOW);
afterEach(async () => {
  await h.restoreParams();
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
  const until = Date.now() + 2_000;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked",
      [waiter, holder],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < until);
  throw new Error("没有观察到真实业务锁等待");
}
function service(client = h.prisma, runner?: TxRunner) {
  const side = h.side(client, runner);
  const expiry = createInvitationExpiry({ clock: h.clock, flow: side.flow, timers: side.timers });
  return {
    ...side,
    expiry,
    heal: (scope: InvariantScope, now = h.clock.now()) =>
      side.tx.run((tx) => expiry.checkI30(tx, scope, now), { timeoutMs: TX_TIMEOUT_MAX_MS }),
  };
}
const subjectId = (row: { subject?: InvariantSubject }) =>
  row.subject !== undefined && "id" in row.subject ? row.subject.id : undefined;
async function overdue() {
  const owner = await h.owner(),
    card = await h.card(owner);
  h.clock.set(new Date(new Date(card.expiresAt).getTime() + HOUR + 1));
  return { owner, card };
}
async function healed(id: string) {
  const trace = await h.trace(id);
  expect(trace.row).toMatchObject({ status: "expired", tokenEnc: null });
  expect(trace.history.map((row) => row.event)).toEqual(["invitation.create", "invitation.expire"]);
  expect(trace.audits).toHaveLength(2);
  expect(trace.events.map((row) => row.eventType)).toEqual([
    "invitation.created",
    "invitation.expired",
  ]);
  expect(trace.events[1]!.dedupeKey).toBe(`tmr:invitation.expire:invitation:${id}`);
  expect(trace.timers.every((row) => row.status === "cancelled")).toBe(true);
  return trace;
}

describe("I30：真实共享到期迁移与有界候选", { timeout: SLOW }, () => {
  it.each([-1, 0, 1])("严格超过一小时，边界偏移%s毫秒", async (delta) => {
    const owner = await h.owner(),
      card = await h.card(owner);
    const at = new Date(new Date(card.expiresAt).getTime() + HOUR + delta);
    h.clock.set(at);
    const before = await h.trace(card.invitationId);
    const result = await service().heal({ entityIds: [owner.entityId] }, at);
    if (delta <= 0) {
      expect(result).toEqual([]);
      expect(await h.trace(card.invitationId)).toEqual(before);
    } else {
      expect(result).toEqual([
        {
          subject: { type: "invitation", id: card.invitationId },
          entityId: owner.entityId,
          detail: { expiresAt: card.expiresAt },
          healed: { action: "invitation.expire", at },
        },
      ]);
      await healed(card.invitationId);
      const after = await h.trace(card.invitationId);
      expect(await service().heal({ entityIds: [owner.entityId] })).toEqual([]);
      expect(await h.trace(card.invitationId)).toEqual(after);
    }
  });

  it("空主体范围不扩成全库；限定主体不触碰其他合法过期行", async () => {
    const first = await overdue(),
      second = await overdue(),
      one = service();
    const before = await h.trace(first.card.invitationId);
    expect(await one.heal({ entityIds: [] })).toEqual([]);
    expect(await one.heal({ entityIds: [uuidv7()] })).toEqual([]);
    expect(await h.trace(first.card.invitationId)).toEqual(before);
    expect(await one.heal({ entityIds: [second.owner.entityId] })).toHaveLength(1);
    expect(await h.trace(first.card.invitationId)).toEqual(before);
    await healed(second.card.invitationId);
    await expect(one.heal({}, new Date(Number.NaN))).rejects.toThrow("有效业务时间");
  });

  it("真实dispatched任务被I30同事务取消；旧ref不再迁移", async () => {
    const { owner, card } = await overdue(),
      ref = await h.claim(card.invitationId);
    expect((await h.trace(card.invitationId)).timers[0]!.status).toBe("dispatched");
    expect(await service().heal({ entityIds: [owner.entityId] })).toHaveLength(1);
    await healed(card.invitationId);
    expect(await runTimer(h.timerDeps, ref)).toBe("stale");
  });

  it("原真实runTimer仍保留当前任务，最终fired而非自取消", async () => {
    const { owner, card } = await overdue();
    expect(await h.run(card.invitationId)).toBe("fired");
    const trace = await h.trace(card.invitationId);
    expect(trace.row.status).toBe("expired");
    expect(trace.timers[0]!.status).toBe("fired");
    expect(await service().heal({ entityIds: [owner.entityId] })).toEqual([]);
    expect(await h.trace(card.invitationId)).toEqual(trace);
  });

  it.each(["transition", "cancel", "outer"] as const)(
    "%s失败回滚迁移、审计、事件和timer",
    async (point) => {
      const { owner, card } = await overdue(),
        one = service(),
        before = await h.trace(card.invitationId);
      const expiry = createInvitationExpiry({
        clock: h.clock,
        flow:
          point === "transition"
            ? {
                ...one.flow,
                transition: async (...args) => {
                  await one.flow.transition(...args);
                  throw new Error("迁移后回滚");
                },
              }
            : one.flow,
        timers: {
          cancel: async (...args) => {
            const result = await one.timers.cancel(...args);
            if (point === "cancel") throw new Error("取消后回滚");
            return result;
          },
        },
      });
      await expect(
        one.tx.run(async (tx) => {
          await expiry.checkI30(tx, { entityIds: [owner.entityId] }, h.clock.now());
          throw new Error("外层回滚");
        }),
      ).rejects.toThrow("回滚");
      expect(await h.trace(card.invitationId)).toEqual(before);
      expect(await one.heal({ entityIds: [owner.entityId] })).toHaveLength(1);
      await healed(card.invitationId);
    },
  );

  it("唯一201合法历史边界：稳定排序先200，下一轮只剩1", async () => {
    const { owner, card } = await overdue();
    const original = await h.prisma.invitation.findUniqueOrThrow({
      where: { id: card.invitationId },
    });
    // 合法历史漏调度候选，不伪造FiredTimer，也不把批量夹具称为公共创建限额测试。
    const rows = Array.from({ length: 200 }, () => {
      const id = uuidv7();
      return {
        ...original,
        id,
        clientRequestId: uuidv7(),
        tokenHash: createHash("sha256").update(id).digest(),
      };
    });
    await h.prisma.invitation.createMany({ data: rows });
    const ids = [original.id, ...rows.map((row) => row.id)].sort();
    const one = service();
    const first = await one.heal({ entityIds: [owner.entityId] });
    expect(first.map(subjectId)).toEqual(ids.slice(0, 200));
    expect(
      await h.prisma.invitation.count({ where: { entityId: owner.entityId, status: "pending" } }),
    ).toBe(1);
    expect((await one.heal({ entityIds: [owner.entityId] })).map(subjectId)).toEqual(
      ids.slice(200),
    );
    expect(await one.heal({ entityIds: [owner.entityId] })).toEqual([]);
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: { in: ids }, event: "invitation.expire" },
      }),
    ).toBe(201);
  });
});

describe("I30：两业务连接与只读阻断观察", { timeout: SLOW }, () => {
  it("真实public复用先续期持100，I30锁后保留新卡与scheduled任务", async () => {
    const owner = await h.owner(),
      card = await h.card(owner);
    const oldExpiry = new Date(card.expiresAt),
      entered = latch(),
      release = latch();
    h.clock.set(new Date(oldExpiry.getTime() - 1));
    const real = createTxRunner({ prisma: clients[0]!, appEnv: "test" });
    let gated = false;
    const runner: TxRunner = {
      run: (fn, options) =>
        real.run(async (tx) => {
          const result = await fn(tx);
          const row = await tx.invitation.findUniqueOrThrow({ where: { id: card.invitationId } });
          if (!gated && row.expiresAt > oldExpiry) {
            gated = true;
            entered.release();
            await release.promise;
          }
          return result;
        }, options),
    };
    const renewing = Promise.allSettled([
      h.side(clients[0]!, runner).tenant.createInvitation(owner.ctx, { clientRequestId: uuidv7() }),
    ]);
    const observer = await connectTestDatabase(db.name, { role: null });
    let healing: Promise<unknown> | undefined;
    try {
      await entered.promise;
      h.clock.set(new Date(oldExpiry.getTime() + HOUR + 1));
      healing = service(clients[1]!).heal({ entityIds: [owner.entityId] });
      await blocked(observer, pids[1]!, pids[0]!);
      release.release();
      expect(await healing).toEqual([]);
      const [result] = await renewing;
      expect(result?.status).toBe("fulfilled");
      if (result?.status === "fulfilled")
        expect(result.value).toMatchObject({ invitationId: card.invitationId, isReused: true });
      const trace = await h.trace(card.invitationId);
      expect(trace.row.status).toBe("pending");
      expect(trace.row.expiresAt > h.clock.now()).toBe(true);
      expect(trace.history).toHaveLength(1);
      expect(trace.events).toHaveLength(1);
      expect(trace.requests).toHaveLength(2);
      expect(trace.timers.filter((row) => row.status === "scheduled")).toHaveLength(1);
    } finally {
      release.release();
      await Promise.allSettled([renewing, ...(healing ? [healing] : [])]);
      await observer.end();
    }
  });

  it.each(["clock", "renewal"] as const)("等待100后复核%s，不用锁前到期事实", async (mode) => {
    const { owner, card } = await overdue(),
      fixed = h.clock.now(),
      entered = latch(),
      release = latch();
    const observer = await connectTestDatabase(db.name, { role: null });
    const holder = createTxRunner({ prisma: clients[0]!, appEnv: "test" });
    let pending: Promise<unknown> | undefined;
    const holding = holder.run(async (tx) => {
      await lockRows(tx, "entity", [owner.entityId]);
      await lockRows(tx, "invitation", [card.invitationId]);
      if (mode === "renewal")
        await tx.invitation.update({
          where: { id: card.invitationId },
          data: { expiresAt: new Date(fixed.getTime() + HOUR) },
        });
      entered.release();
      await release.promise;
    });
    const held = Promise.allSettled([holding]);
    try {
      await entered.promise;
      pending = service(clients[1]!).heal({ entityIds: [owner.entityId] }, fixed);
      await blocked(observer, pids[1]!, pids[0]!);
      if (mode === "clock") h.clock.set(new Date(new Date(card.expiresAt).getTime() - 1));
      release.release();
      expect(await pending).toEqual([]);
      expect((await held)[0]!.status).toBe("fulfilled");
      expect((await h.trace(card.invitationId)).row.status).toBe("pending");
      expect((await h.trace(card.invitationId)).history).toHaveLength(1);
    } finally {
      release.release();
      await Promise.allSettled([held, ...(pending ? [pending] : [])]);
      h.clock.set(fixed);
      await observer.end();
    }
  });

  it.each(["heal", "revoke", "timer"] as const)("%s先持100：竞争仅一次真实迁移", async (winner) => {
    const { owner, card } = await overdue(),
      entered = latch(),
      release = latch();
    const observer = await connectTestDatabase(db.name, { role: null });
    const real = createTxRunner({ prisma: clients[0]!, appEnv: "test" });
    let gated = false;
    const runner: TxRunner = {
      run: (fn, options) =>
        real.run(async (tx) => {
          const result = await fn(tx);
          const row = await tx.invitation.findUnique({ where: { id: card.invitationId } });
          if (!gated && row?.status !== "pending") {
            gated = true;
            entered.release();
            await release.promise;
          }
          return result;
        }, options),
    };
    const one = service(clients[0]!, runner),
      two = service(clients[1]!);
    const ref = winner === "timer" ? await h.claim(card.invitationId, one) : undefined;
    const winning =
      winner === "revoke"
        ? one.tenant.revokeInvitation(owner.ctx, {
            invitationId: card.invitationId,
            reason: "by_owner",
          })
        : winner === "timer"
          ? runTimer(one.timerDeps, ref!)
          : one.heal({ entityIds: [owner.entityId] });
    const won = Promise.allSettled([winning]);
    let losing: Promise<unknown> | undefined;
    try {
      await entered.promise;
      losing = two.heal({ entityIds: [owner.entityId] });
      await blocked(observer, pids[1]!, pids[0]!);
      release.release();
      expect(await losing).toEqual([]);
      expect((await won)[0]!.status).toBe("fulfilled");
      const trace = await h.trace(card.invitationId);
      expect(trace.row.status).toBe(winner === "revoke" ? "revoked" : "expired");
      expect(trace.history).toHaveLength(2);
      expect(trace.audits).toHaveLength(2);
      expect(trace.events).toHaveLength(2);
      expect(trace.timers[0]!.status).toBe(winner === "timer" ? "fired" : "cancelled");
    } finally {
      release.release();
      await Promise.allSettled([won, ...(losing ? [losing] : [])]);
      await observer.end();
    }
  });

  it("I30先提交后真实revoke明确拒绝，不覆写expired", async () => {
    const { owner, card } = await overdue();
    await service(clients[0]!).heal({ entityIds: [owner.entityId] });
    const before = await h.trace(card.invitationId);
    await expect(
      h.side(clients[1]!).tenant.revokeInvitation(owner.ctx, {
        invitationId: card.invitationId,
        reason: "by_owner",
      }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await h.trace(card.invitationId)).toEqual(before);
  });

  it("真实accept已持100时跨到I30期限：锁后accepted不再到期", async () => {
    const owner = await h.owner(),
      card = await h.card(owner),
      person = await h.person();
    const entered = latch(),
      release = latch(),
      observer = await connectTestDatabase(db.name, { role: null });
    const real = createTxRunner({ prisma: clients[0]!, appEnv: "test" });
    let gated = false;
    const runner: TxRunner = {
      run: (fn, options) =>
        real.run(async (tx) => {
          const result = await fn(tx);
          const row = await tx.invitation.findUnique({ where: { id: card.invitationId } });
          if (!gated && row?.status === "accepted") {
            gated = true;
            entered.release();
            await release.promise;
          }
          return result;
        }, options),
    };
    const accepting = Promise.allSettled([h.accept(person, card, {}, h.side(clients[0]!, runner))]);
    let healing: Promise<unknown> | undefined;
    try {
      await entered.promise;
      h.clock.set(new Date(new Date(card.expiresAt).getTime() + HOUR + 1));
      healing = service(clients[1]!).heal({ entityIds: [owner.entityId] });
      await blocked(observer, pids[1]!, pids[0]!);
      release.release();
      expect(await healing).toEqual([]);
      expect((await accepting)[0]!.status).toBe("fulfilled");
      const trace = await h.trace(card.invitationId);
      expect(trace.row.status).toBe("accepted");
      expect(trace.history).toHaveLength(2);
      expect(trace.events.map((row) => row.eventType)).toEqual([
        "invitation.created",
        "invitation.accepted",
      ]);
      expect(trace.timers.every((row) => row.status === "cancelled")).toBe(true);
    } finally {
      release.release();
      await Promise.allSettled([accepting, ...(healing ? [healing] : [])]);
      await observer.end();
    }
  });

  it("I30先赢后真实accept不建立成员，保持过期终态", async () => {
    const { owner, card } = await overdue(),
      person = await h.person();
    await service(clients[0]!).heal({ entityIds: [owner.entityId] });
    const trace = await h.trace(card.invitationId);
    await expect(h.accept(person, card, {}, h.side(clients[1]!))).rejects.toMatchObject({
      error: "INVITATION_EXPIRED",
    });
    expect(await h.trace(card.invitationId)).toEqual(trace);
    expect(
      await h.prisma.entityMember.count({
        where: { entityId: owner.entityId, merchantUserId: person.userId },
      }),
    ).toBe(0);
  });

  it("两主体逆序输入先完整sorted100再110；并发批次仅一个赢家", async () => {
    const first = await overdue(),
      second = await overdue();
    const entities = [first.owner.entityId, second.owner.entityId].sort();
    const entered = latch(),
      release = latch(),
      observer = await connectTestDatabase(db.name, { role: null });
    const real = createTxRunner({ prisma: clients[0]!, appEnv: "test" });
    const runner: TxRunner = {
      run: (fn, options) =>
        real.run(async (tx) => {
          const result = await fn(tx);
          entered.release();
          await release.promise;
          return result;
        }, options),
    };
    const firstRun = Promise.allSettled([
      service(clients[0]!, runner).heal({ entityIds: [...entities].reverse() }),
    ]);
    let secondRun: Promise<unknown> | undefined;
    try {
      await entered.promise;
      secondRun = service(clients[1]!).heal({ entityIds: entities });
      await blocked(observer, pids[1]!, pids[0]!);
      release.release();
      expect(await secondRun).toEqual([]);
      const [result] = await firstRun;
      expect(result?.status).toBe("fulfilled");
      if (result?.status === "fulfilled") expect(result.value).toHaveLength(2);
      await healed(first.card.invitationId);
      await healed(second.card.invitationId);
    } finally {
      release.release();
      await Promise.allSettled([firstRun, ...(secondRun ? [secondRun] : [])]);
      await observer.end();
    }
  });
});
