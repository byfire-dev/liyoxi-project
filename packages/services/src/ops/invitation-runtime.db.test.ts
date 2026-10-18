import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFlow } from "../flow/index.js";
import { createIdentityContext, createTxRunner, uuidv7 } from "../kernel/index.js";
import { createTenant, createInvitationExpiry } from "../tenant/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import { claimTimers } from "../timers/index.js";
import type { TimerRef } from "../timers/index.js";
import { createInvitationAssembly } from "./invitation-runtime.js";
import { buildWorkerServices } from "./worker.js";

const SLOW = 120_000;
const db = useSeededDatabase("services");
const clock = createClock();
let prisma: Awaited<ReturnType<typeof db.prisma>>;
const owned: ReturnType<typeof buildWorkerServices>[] = [];
const refs: TimerRef[] = [];
beforeAll(async () => {
  prisma = await db.prisma();
}, SLOW);
function build(otherClock = clock) {
  const one = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock: otherClock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createFakeProviders({ clock: otherClock }),
    channel: {
      downForMs: () => 0,
      enqueue: async (_queue, _id, raw) => {
        if (
          typeof raw === "object" &&
          raw !== null &&
          "timerId" in raw &&
          "kind" in raw &&
          "dispatchNo" in raw &&
          typeof raw.timerId === "string" &&
          typeof raw.kind === "string" &&
          typeof raw.dispatchNo === "number"
        )
          refs.push({ timerId: raw.timerId, kind: raw.kind, dispatchNo: raw.dispatchNo });
      },
    },
  });
  owned.push(one);
  return one;
}
afterAll(async () => {
  for (const one of owned.reverse()) {
    one.closeInvitations?.();
    one.closeProfile?.();
    one.closeApproval?.();
    await one.shutdownMediaJobs?.();
    one.closeMediaJobs?.();
    await one.closeDocs();
    await one.documentConverter?.close();
    await one.closeNotify();
    await one.closeAnalytics?.();
    await one.closeStaff?.();
    await one.closeSmsHealth?.();
    await one.closeAlertFacts?.();
    one.closeOrder?.();
    one.closeBillingTimers?.();
    one.closePublish?.();
    one.closeDelivery?.();
    one.closeWebhooks?.();
    await one.closeMediaDrivers?.();
    await one.closeStorageDrivers?.();
  }
}, SLOW);
async function world(worker: ReturnType<typeof buildWorkerServices>, businessClock = clock) {
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const flow = createFlow({
    assembly: worker.assembly,
    clock: businessClock,
    events: worker.events,
  });
  const tenant = createTenant({
    tx,
    clock: businessClock,
    flow,
    assembly: worker.assembly,
    events: worker.events,
    invitations: {
      keyring: () => TEST_KEYRING,
      timers: worker.timers,
      checkRemark: async () => {},
    },
  });
  const make = createFactories({ db: prisma, clock: businessClock });
  const user = await make.merchantUser();
  const created = await tenant.createEntity(
    createIdentityContext({ actor: { type: "merchant", id: user.id, client: "weapp" } }),
  );
  const ctx = createIdentityContext({
    actor: { type: "merchant", id: user.id, client: "weapp" },
    entityId: created.entityId,
    storeId: created.storeId,
  });
  const card = await tenant.createInvitation(ctx, { clientRequestId: uuidv7() });
  const timer = await prisma.timer.findFirstOrThrow({ where: { subjectId: card.invitationId } });
  return { tx, flow, tenant, card, ctx, timer, user, ...created };
}
async function due(id: string) {
  await prisma.timer.update({ where: { id }, data: { fireAt: new Date(0), retryAt: null } });
}

describe("真实邀请expiry运行时", { timeout: SLOW }, () => {
  it("scoped处理器/索引同对象，缺登记/未attach/重复attach/close均明确拒绝", async () => {
    const base = assembleForTest({ entry: "worker" }),
      scope = createInvitationAssembly(base);
    const handler = scope.assembly.timerHandler("invitation.expire")!;
    expect(handler).toBe(
      scope.assembly.timerHandlers.find((item) => item.kind === "invitation.expire"),
    );
    expect(handler.maxLateMinutes).toBeUndefined();
    expect(handler.rearmAfterSkip).toBeUndefined();
    expect(() => createInvitationAssembly({ ...base, timerHandlers: [] })).toThrow("唯一");
    const tx = createTxRunner({ prisma, appEnv: "test" });
    const timer = {
      id: uuidv7(),
      kind: "invitation.expire",
      subjectType: "invitation",
      subjectId: uuidv7(),
      payload: null,
    };
    await expect(tx.run((handle) => handler.handle(handle, timer))).rejects.toThrow("尚未绑定");
    const worker = build(),
      w = await world(worker);
    const expiry = createInvitationExpiry({ clock, flow: w.flow, timers: worker.timers });
    scope.attach(expiry);
    expect(() => scope.attach(expiry)).toThrow("只能绑定一次");
    scope.close();
    scope.close();
    expect(() => scope.attach(expiry)).toThrow("只能绑定一次");
    await expect(tx.run((handle) => handler.handle(handle, timer))).rejects.toThrow("已经关闭");
  });

  it("真实scan→队列ref→runTimer恰一次expire，strict事件中继无虚构消费者", async () => {
    const worker = build(),
      w = await world(worker);
    clock.set(new Date(w.card.expiresAt));
    await due(w.timer.id);
    await worker.scan();
    const ref = refs.find((item) => item.timerId === w.timer.id);
    expect(ref).toBeDefined();
    expect(await worker.runTimer(ref!)).toBe("fired");
    expect(await worker.runTimer(ref!)).toBe("stale");
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: w.card.invitationId } });
    expect(row).toMatchObject({ status: "expired", tokenEnc: null });
    expect((await prisma.timer.findUniqueOrThrow({ where: { id: w.timer.id } })).status).toBe(
      "fired",
    );
    const events = await prisma.outboxEvent.findMany({ where: { aggregateId: row.id } });
    expect(events).toHaveLength(2);
    const expired = events.find((item) => item.eventType === "invitation.expired")!;
    expect(expired).toMatchObject({
      dedupeKey: `tmr:invitation.expire:invitation:${row.id}`,
      payload: {
        v: 1,
        invitationId: row.id,
        entityId: w.entityId,
        storeId: w.storeId,
        fromState: "pending",
        toState: "expired",
        transition: "invitation.expire",
      },
    });
    await worker.relay();
    expect(await prisma.outboxDelivery.count({ where: { outboxEventId: expired.id } })).toBe(0);
    expect(await prisma.statusTransition.count({ where: { subjectId: row.id } })).toBe(2);
  });

  it("早到pending沿runTimer重试/backoff，不生成skipped/pending死路；终态才skipped", async () => {
    const worker = build(),
      w = await world(worker);
    await due(w.timer.id);
    await worker.scan();
    const ref = refs.find((item) => item.timerId === w.timer.id)!;
    expect(await worker.runTimer(ref)).toBe("retry");
    expect(await prisma.timer.findUniqueOrThrow({ where: { id: w.timer.id } })).toMatchObject({
      status: "scheduled",
      attempts: 1,
    });
    expect(
      (await prisma.invitation.findUniqueOrThrow({ where: { id: w.card.invitationId } })).status,
    ).toBe("pending");
    expect(await prisma.statusTransition.count({ where: { subjectId: w.card.invitationId } })).toBe(
      1,
    );
    const handler = worker.assembly.timerHandler("invitation.expire")!;
    await w.tenant.revokeInvitation(w.ctx, {
      invitationId: w.card.invitationId,
      reason: "by_owner",
    });
    expect(
      await w.tx.run((tx) =>
        handler.handle(tx, {
          id: w.timer.id,
          kind: "invitation.expire",
          subjectType: "invitation",
          subjectId: w.card.invitationId,
          payload: null,
        }),
      ),
    ).toBe("skipped");
    expect(
      await w.tx.run((tx) =>
        handler.handle(tx, {
          id: uuidv7(),
          kind: "invitation.expire",
          subjectType: "invitation",
          subjectId: uuidv7(),
          payload: null,
        }),
      ),
    ).toBe("skipped");
  });

  it("真实早到六次耗尽后原arm复活，推进期限后expire一次且不依赖邀请人仍active", async () => {
    const worker = build(),
      w = await world(worker);
    for (let attempt = 1; attempt <= 6; attempt++) {
      await due(w.timer.id);
      const start = refs.length;
      await worker.scan();
      const ref = refs.slice(start).find((item) => item.timerId === w.timer.id);
      expect(ref).toBeDefined();
      expect(await worker.runTimer(ref!)).toBe(attempt === 6 ? "failed" : "retry");
      expect(await prisma.timer.findUniqueOrThrow({ where: { id: w.timer.id } })).toMatchObject({
        status: attempt === 6 ? "failed" : "scheduled",
        attempts: attempt,
      });
    }
    expect(await prisma.statusTransition.count({ where: { subjectId: w.card.invitationId } })).toBe(
      1,
    );
    const card = await w.tenant.createInvitation(w.ctx, { clientRequestId: uuidv7() });
    expect(card.invitationId).toBe(w.card.invitationId);
    expect(card.token).toBe(w.card.token);
    expect(await prisma.timer.findUniqueOrThrow({ where: { id: w.timer.id } })).toMatchObject({
      status: "scheduled",
      attempts: 0,
      retryAt: null,
      firedAt: null,
    });
    await prisma.merchantUser.update({ where: { id: w.user.id }, data: { status: "disabled" } });
    clock.set(new Date(card.expiresAt));
    await due(w.timer.id);
    const start = refs.length;
    await worker.scan();
    const ref = refs.slice(start).find((item) => item.timerId === w.timer.id)!;
    expect(await worker.runTimer(ref)).toBe("fired");
    expect(await worker.runTimer(ref)).toBe("stale");
    expect(
      (await prisma.invitation.findUniqueOrThrow({ where: { id: card.invitationId } })).status,
    ).toBe("expired");
    expect(await prisma.statusTransition.count({ where: { subjectId: card.invitationId } })).toBe(
      2,
    );
    expect(await prisma.outboxEvent.count({ where: { aggregateId: card.invitationId } })).toBe(2);
  });

  it("两个真实worker各持clock/闭包，关闭一个不借另一个；未来异常任务不假成功", async () => {
    const later = createClock(clock.now()),
      a = build(),
      b = build(later),
      w = await world(b, later);
    clock.set(new Date(w.card.expiresAt));
    await due(w.timer.id);
    const claimed = await w.tx.run((tx) => claimTimers(tx, b.timers.registry, clock.now()));
    const ref = claimed.claimed.find((item) => item.timerId === w.timer.id)!;
    expect(a.assembly.timerHandler("invitation.expire")).not.toBe(
      b.assembly.timerHandler("invitation.expire"),
    );
    a.closeInvitations?.();
    expect(await b.runTimer(ref)).toBe("retry");
    const handler = a.assembly.timerHandler("invitation.expire")!;
    await expect(
      w.tx.run((tx) =>
        handler.handle(tx, {
          id: w.timer.id,
          kind: "invitation.expire",
          subjectType: "invitation",
          subjectId: w.card.invitationId,
          payload: null,
        }),
      ),
    ).rejects.toThrow("已经关闭");
    for (const status of ["skipped", "fired"] as const) {
      await prisma.timer.update({
        where: { id: w.timer.id },
        data: { status, firedAt: clock.now() },
      });
      const before = await prisma.invitation.findUniqueOrThrow({
        where: { id: w.card.invitationId },
      });
      await expect(
        w.tenant.createInvitation(w.ctx, { clientRequestId: uuidv7() }),
      ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
      expect(await prisma.invitation.findUniqueOrThrow({ where: { id: before.id } })).toEqual(
        before,
      );
      expect(await prisma.invitationRequest.count({ where: { invitationId: before.id } })).toBe(1);
    }
  });

  it("expiry真实事件后失败回滚业务，失败短Tx只回scheduled", async () => {
    const worker = build(),
      w = await world(worker);
    clock.set(new Date(w.card.expiresAt));
    await due(w.timer.id);
    await worker.scan();
    const ref = refs.find((item) => item.timerId === w.timer.id)!;
    const emit = worker.events.emit.bind(worker.events);
    const fail = vi.spyOn(worker.events, "emit").mockImplementation(async (...args) => {
      await emit(...args);
      throw new Error("expiry事件后故障");
    });
    try {
      expect(await worker.runTimer(ref)).toBe("retry");
      expect(
        (await prisma.invitation.findUniqueOrThrow({ where: { id: w.card.invitationId } })).status,
      ).toBe("pending");
      expect(
        await prisma.statusTransition.count({ where: { subjectId: w.card.invitationId } }),
      ).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { aggregateId: w.card.invitationId } })).toBe(
        1,
      );
      expect((await prisma.timer.findUniqueOrThrow({ where: { id: w.timer.id } })).attempts).toBe(
        1,
      );
    } finally {
      fail.mockRestore();
    }
  });
});
