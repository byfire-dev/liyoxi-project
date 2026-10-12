import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { describe, expect, it } from "vitest";
import { createTxRunner, isAppError, lockRows } from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import type { Tenant } from "../tenant/index.js";
import { connectTestDatabase, useSeededDatabase } from "../testing/index.js";
import { lifecycleHarness, SLOW } from "./__fixtures__/tenant-account-lifecycle.js";
import type { LifecycleHarness } from "./__fixtures__/tenant-account-lifecycle.js";

const db = useSeededDatabase("services", { label: "accountrace" });
interface Scenario {
  h: LifecycleHarness;
  clients: PrismaClient[];
  runners: TxRunner[];
  sides: Tenant[];
  pids: number[];
}
async function scenario(action: (s: Scenario) => Promise<void>) {
  const url = await db.url(),
    clients = [0, 1].map(() => createPrismaClient({ connectionString: url, max: 1 }));
  let h: LifecycleHarness | undefined;
  try {
    h = await lifecycleHarness(clients[0]!);
    const runners = [h.tx, createTxRunner({ prisma: clients[1]!, appEnv: "test" })];
    const sides = runners.map((runner) => h!.service(runner));
    const pids = await Promise.all(
      clients.map(async (client) => {
        const [row] = await client.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        if (!row) throw new Error("callerTx业务连接没有PID");
        return row.pid;
      }),
    );
    expect(new Set(pids).size).toBe(2);
    await action({ h, clients, runners, sides, pids });
  } finally {
    try {
      h?.close();
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  }
}
function pause(s: Scenario, condition: (tx: Tx) => Promise<boolean>, failure?: Error) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner: TxRunner = {
    run: (fn, options) =>
      s.runners[0]!.run(async (tx) => {
        const result = await fn(tx);
        if (await condition(tx)) {
          enter();
          await gate;
          if (failure) throw failure;
        }
        return result;
      }, options),
  };
  return { runner, tenant: s.h.service(runner), entered, release };
}
async function blocked(observer: Awaited<ReturnType<typeof connectTestDatabase>>, s: Scenario) {
  const until = Date.now() + 2_000;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
      [s.pids[1], s.pids[0]],
    );
    if (result.rows[0]?.blocked) {
      const all = await observer.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY pid",
      );
      expect(all.rows.map((row) => row.pid)).toEqual([...s.pids].sort((a, b) => a - b));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < until);
  throw new Error("两秒内未见两个max1业务PID的真实锁阻塞");
}
async function race(
  s: Scenario,
  hold: ReturnType<typeof pause>,
  firstAction: () => Promise<unknown>,
  secondAction: () => Promise<unknown>,
) {
  const observer = await connectTestDatabase(db.name, { role: null });
  let first: Promise<PromiseSettledResult<unknown>[]> | undefined,
    second: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await observer.query("SET default_transaction_read_only=on");
    first = Promise.allSettled([firstAction()]);
    await Promise.race([
      hold.entered,
      first.then(() => {
        throw new Error("holder未进入真实写事务尾栅栏");
      }),
    ]);
    second = Promise.allSettled([secondAction()]);
    await blocked(observer, s);
    hold.release();
    return [(await first)[0]!, (await second)[0]!] as const;
  } finally {
    hold.release();
    await first;
    await second;
    await observer.end();
  }
}
function code(result: PromiseSettledResult<unknown>) {
  expect(result.status).toBe("rejected");
  const error: unknown = result.status === "rejected" ? result.reason : null;
  expect(isAppError(error)).toBe(true);
  return isAppError(error) ? error.error : null;
}

describe("账号生命周期：callerTx两max1与只读observer竞争", { timeout: SLOW }, () => {
  it.each(["commit", "rollback"] as const)(
    "%s：老板关闭与真实accept竞争，二十轮仅一套终态副作用",
    async (mode) =>
      scenario(async (s) => {
        for (let round = 0; round < 20; round++) {
          const w = await s.h.world(),
            invite = await s.h.invitation(w),
            person = await s.h.sessions.person();
          const failure = new Error(`close rollback ${round}`);
          const hold = pause(
            s,
            async (tx) =>
              (await tx.entity.findUniqueOrThrow({ where: { id: w.entityId } })).lifecycle ===
              "closed",
            mode === "rollback" ? failure : undefined,
          );
          const [first, second] = await race(
            s,
            hold,
            () =>
              hold.runner.run((tx) => hold.tenant.closeEntityForOwnerDeletionIn(tx, w.memberCtx)),
            () => s.h.sessions.accept(person, invite, {}, { ...s.h.sessions, tenant: s.sides[1]! }),
          );
          if (mode === "rollback") {
            expect(first).toEqual({ status: "rejected", reason: failure });
            expect(second.status).toBe("fulfilled");
          } else {
            expect(first.status).toBe("fulfilled");
            expect(code(second)).toBe("INVITATION_REVOKED");
          }
          const entity = await s.h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } });
          expect(entity.lifecycle).toBe(mode === "commit" ? "closed" : "active");
          const invitation = await s.h.prisma.invitation.findUniqueOrThrow({
            where: { id: invite.invitationId },
          });
          expect(invitation.status).toBe(mode === "commit" ? "revoked" : "accepted");
          expect(
            await s.h.prisma.entityMember.count({
              where: { merchantUserId: person.userId, status: "active" },
            }),
          ).toBe(mode === "commit" ? 0 : 1);
          const closes = await s.h.trace(w.entityId);
          expect(closes.history.filter((r) => r.event === "entity.close")).toHaveLength(
            mode === "commit" ? 1 : 0,
          );
          expect(closes.events.filter((r) => r.eventType === "entity.closed")).toHaveLength(
            mode === "commit" ? 1 : 0,
          );
          expect(closes.audits.filter((r) => r.action === "tenant.entity.close")).toHaveLength(
            mode === "commit" ? 1 : 0,
          );
          const trace = await s.h.trace(invite.invitationId);
          expect(
            trace.history.filter(
              (r) => r.event === (mode === "commit" ? "invitation.revoke" : "invitation.accept"),
            ),
          ).toHaveLength(1);
          expect(
            trace.events.filter(
              (r) =>
                r.eventType === (mode === "commit" ? "invitation.revoked" : "invitation.accepted"),
            ),
          ).toHaveLength(1);
          const timer = await s.h.prisma.timer.findFirstOrThrow({
            where: { subjectId: invite.invitationId, kind: "invitation.expire" },
          });
          expect(timer.status).toBe("cancelled");
        }
      }),
  );

  it.each(["commit", "rollback"] as const)(
    "%s：真实createInvitation先持锁，二十轮草稿重读pending事实",
    async (mode) =>
      scenario(async (s) => {
        for (let round = 0; round < 20; round++) {
          const w = await s.h.world(true),
            failure = new Error(`invitation rollback ${round}`);
          const hold = pause(
            s,
            async (tx) => (await tx.invitation.count({ where: { entityId: w.entityId } })) > 0,
            mode === "rollback" ? failure : undefined,
          );
          const [first, second] = await race(
            s,
            hold,
            () => s.h.invitation(w, hold.tenant),
            () => s.runners[1]!.run((tx) => s.sides[1]!.abandonDraftIn(tx, w.memberCtx)),
          );
          if (mode === "commit") {
            expect(first.status).toBe("fulfilled");
            expect(code(second)).toBe("STATE_NOT_ALLOWED");
          } else {
            expect(first).toEqual({ status: "rejected", reason: failure });
            expect(second.status).toBe("fulfilled");
          }
          expect(
            (await s.h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } })).lifecycle,
          ).toBe(mode === "commit" ? "active" : "abandoned");
          expect(
            await s.h.prisma.invitation.count({
              where: { entityId: w.entityId, status: "pending" },
            }),
          ).toBe(mode === "commit" ? 1 : 0);
          const trace = await s.h.trace(w.entityId);
          expect(trace.events.filter((r) => r.eventType === "entity.abandoned")).toHaveLength(
            mode === "commit" ? 0 : 1,
          );
          expect(trace.history.filter((r) => r.event === "entity.abandon")).toHaveLength(
            mode === "commit" ? 0 : 1,
          );
          expect(
            await s.h.prisma.timer.count({
              where: { entityId: w.entityId, kind: "invitation.expire", status: "scheduled" },
            }),
          ).toBe(mode === "commit" ? 1 : 0);
        }
      }),
  );

  it.each(["owner_remove", "leave"] as const)(
    "%s：真实成员清理先提交，二十轮账号清理锁后拒绝失效关系",
    async (kind) =>
      scenario(async (s) => {
        for (let round = 0; round < 20; round++) {
          const w = await s.h.world(),
            c = await s.h.clerk(w);
          const hold = pause(
            s,
            async (tx) =>
              (await tx.entityMember.findUniqueOrThrow({ where: { id: c.member.id } })).status ===
              "removed",
          );
          const [first, second] = await race(
            s,
            hold,
            () =>
              hold.runner.run((tx) =>
                hold.tenant.removeMemberIn(
                  tx,
                  kind === "owner_remove" ? w.memberCtx : c.ctx,
                  kind === "owner_remove" ? { kind, memberId: c.member.id } : { kind },
                ),
              ),
            () =>
              s.runners[1]!.run((tx) =>
                s.sides[1]!.removeMemberIn(tx, c.ctx, {
                  kind: kind === "owner_remove" ? "dormant" : "account_deleted",
                }),
              ),
          );
          expect(first.status).toBe("fulfilled");
          expect(code(second)).toBe(
            kind === "owner_remove" ? "PRECONDITION_CHANGED" : "NOT_A_MEMBER",
          );
          const member = await s.h.prisma.entityMember.findUniqueOrThrow({
            where: { id: c.member.id },
          });
          expect(member).toMatchObject({
            status: "removed",
            removeReason: kind === "owner_remove" ? "by_owner" : "self",
            displayName: "店员姓名",
            lastStoreId: null,
          });
          expect(
            await s.h.prisma.storeMember.count({ where: { entityMemberId: c.member.id } }),
          ).toBe(0);
          const trace = await s.h.trace(c.member.id);
          expect(trace.history).toHaveLength(1);
          expect(trace.events).toHaveLength(1);
          expect(trace.audits).toHaveLength(1);
        }
      }),
  );

  it("账号80锁等待后重新检查disabled，二十轮关闭无任何业务副作用", async () =>
    scenario(async (s) => {
      for (let round = 0; round < 20; round++) {
        const w = await s.h.world();
        const hold = pause(s, async () => true);
        const [first, second] = await race(
          s,
          hold,
          () =>
            hold.runner.run(async (tx) => {
              await lockRows(tx, "merchant_user", [w.merchant.user.id]);
              await tx.merchantUser.update({
                where: { id: w.merchant.user.id },
                data: { status: "disabled" },
              });
            }),
          () =>
            s.runners[1]!.run((tx) => s.sides[1]!.closeEntityForOwnerDeletionIn(tx, w.memberCtx)),
        );
        expect(first.status).toBe("fulfilled");
        expect(code(second)).toBe("NOT_A_MEMBER");
        expect(
          (await s.h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } })).lifecycle,
        ).toBe("active");
        const trace = await s.h.trace(w.entityId);
        expect(trace.history).toEqual([]);
        expect(trace.events).toEqual([]);
        expect(trace.audits).toEqual([]);
        expect(
          await s.h.prisma.entityMember.count({
            where: { entityId: w.entityId, status: "active" },
          }),
        ).toBe(1);
      }
    }));

  it("真实新邀请先提交，二十轮owner关闭重建完整图并取消新增timer", async () =>
    scenario(async (s) => {
      for (let round = 0; round < 20; round++) {
        const w = await s.h.world();
        const hold = pause(
          s,
          async (tx) => (await tx.invitation.count({ where: { entityId: w.entityId } })) > 0,
        );
        const [first, second] = await race(
          s,
          hold,
          () => s.h.invitation(w, hold.tenant),
          () =>
            s.runners[1]!.run((tx) => s.sides[1]!.closeEntityForOwnerDeletionIn(tx, w.memberCtx)),
        );
        expect(first.status).toBe("fulfilled");
        expect(second.status).toBe("fulfilled");
        const invites = await s.h.prisma.invitation.findMany({ where: { entityId: w.entityId } });
        expect(invites).toHaveLength(1);
        expect(invites[0]).toMatchObject({
          status: "revoked",
          tokenEnc: null,
          revokeReason: "entity_closed",
        });
        if (second.status === "fulfilled")
          expect(second.value).toMatchObject({
            invitationIds: [invites[0]!.id],
            withdrawnCancelRequestIds: [],
          });
        const trace = await s.h.trace(invites[0]!.id);
        expect(trace.history.map((r) => r.event)).toEqual([
          "invitation.create",
          "invitation.revoke",
        ]);
        expect(trace.events.map((r) => r.eventType)).toEqual([
          "invitation.created",
          "invitation.revoked",
        ]);
        expect(await s.h.prisma.timer.findMany({ where: { subjectId: invites[0]!.id } })).toEqual([
          expect.objectContaining({ status: "cancelled" }),
        ]);
        expect(await s.h.prisma.storeMember.count({ where: { entityId: w.entityId } })).toBe(0);
        expect(
          await s.h.prisma.entityMember.count({
            where: { entityId: w.entityId, status: "active" },
          }),
        ).toBe(0);
      }
    }));
});
